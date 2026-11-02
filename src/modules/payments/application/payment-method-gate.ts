import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { PaymentMethod } from '@prisma/client';
import {
  PAYMENT_METHOD_REPOSITORY,
  type PaymentMethodRepository,
} from '../../payment-methods/domain/ports/payment-method-repository.port';
import type { ClinicPaymentMethodEntity } from '../../payment-methods/domain/payment-method.entity';
import {
  DUPLICATE_REFERENCE_REASON_MAX,
  DUPLICATE_REFERENCE_REASON_TOO_LONG_MESSAGE,
  PAYMENT_METHOD_INACTIVE_MESSAGE,
  PAYMENT_METHOD_NOT_FOUND_MESSAGE,
  PAYMENT_REFERENCE_DUPLICATE,
  duplicateReferenceWindow,
  legacyPaymentMethodOf,
  normalizeReference,
  referenceError,
} from '../../payment-methods/domain/payment-method-rules';
import {
  PAYMENT_REPOSITORY,
  type CivilPaidDay,
  type PaymentRepository,
  type ReferenceMatch,
} from '../domain/ports/payment-repository.port';
import {
  computePaymentAdjustments,
  type ComputedAdjustment,
} from '../../payment-methods/domain/payment-adjustments';
import {
  CURRENCY_DIGITS_CATALOG,
  type CurrencyDigitsCatalog,
} from '../../../shared/money/currency-digits';

export interface PaymentMethodRequest {
  paymentMethodId?: string;
  method?: PaymentMethod;
  reference?: string;
  duplicateReferenceReason?: string;
}

export interface ResolvedPaymentMethod {
  paymentMethodId: string | null;
  method: PaymentMethod | undefined;
  reference: string | null;
  referenceNormalized: string | null;
  duplicateReferenceReason: string | null;
  duplicateReferenceOf: string[];
  /**
   * DX-516: los ajustes del medio calculados sobre el importe del abono (lo
   * que se congela en él). Vacío sin ajustes, sin medio o sin `charge`.
   */
  adjustments: ComputedAdjustment[];
}

/** DX-516: el importe y la moneda del abono, para calcular sus ajustes. */
export interface PaymentCharge {
  amount: number;
  currency: string;
}

function duplicateMessage(count: number): string {
  return count === 1
    ? 'Esta referencia ya se usó con este medio de pago en otro abono de los últimos 90 días. Revisa el pago o confirma con un motivo.'
    : `Esta referencia ya se usó con este medio de pago en ${count} abonos de los últimos 90 días. Revisa el pago o confirma con un motivo.`;
}

/** El instante con que se mide la ventana: un día civil cuenta a mediodía UTC. */
function windowCenter(paidAt: Date | CivilPaidDay): Date {
  return paidAt instanceof Date
    ? paidAt
    : new Date(`${paidAt.civilDate}T12:00:00.000Z`);
}

/**
 * DX-377: el medio de pago y la referencia de un abono (a un plan o a un
 * saldo migrado). Resuelve el medio en ESTA clínica (RLS; nunca se confía en
 * el id del cliente), deriva el método antiguo de su tipo base, exige la
 * referencia si el medio la pide y avisa (409, `PAYMENT_REFERENCE_DUPLICATE`)
 * si la misma referencia y medio ya están en un abono vivo de ±90 días, salvo
 * que llegue `duplicateReferenceReason`. El aviso se comprueba fuera de la
 * transacción del alta: es una advertencia para la caja, no una restricción
 * (dos cobros simultáneos con la misma referencia pueden pasar los dos).
 */
@Injectable()
export class PaymentMethodGate {
  constructor(
    @Inject(PAYMENT_METHOD_REPOSITORY)
    private readonly methods: PaymentMethodRepository,
    @Inject(PAYMENT_REPOSITORY)
    private readonly payments: PaymentRepository,
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly digits: CurrencyDigitsCatalog,
  ) {}

  /**
   * DX-516: con `charge`, además calcula los ajustes del medio (leídos con
   * el medio, en la misma lectura bajo RLS) sobre ese importe, con los
   * decimales de redondeo de su moneda (DX-340). Es la foto que el abono
   * congela: cambiar la configuración después no la recalcula.
   */
  async resolve(
    input: PaymentMethodRequest,
    paidAt: Date | CivilPaidDay,
    charge?: PaymentCharge,
  ): Promise<ResolvedPaymentMethod> {
    const medium = await this.medium(input);
    const requiresReference = medium?.requiresReference ?? false;
    const error = referenceError(input.reference, requiresReference);
    if (error !== null) throw new BadRequestException(error);
    const referenceNormalized = normalizeReference(input.reference);
    const reference =
      referenceNormalized === null ? null : (input.reference?.trim() ?? null);

    const reason = input.duplicateReferenceReason?.trim() || null;
    if (reason !== null && reason.length > DUPLICATE_REFERENCE_REASON_MAX) {
      throw new BadRequestException(
        DUPLICATE_REFERENCE_REASON_TOO_LONG_MESSAGE,
      );
    }

    const matches =
      medium && referenceNormalized
        ? await this.payments.findReferenceMatches({
            paymentMethodId: medium.id,
            referenceNormalized,
            ...duplicateReferenceWindow(windowCenter(paidAt)),
          })
        : [];
    if (matches.length > 0 && reason === null) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: PAYMENT_REFERENCE_DUPLICATE,
        message: duplicateMessage(matches.length),
        matches: matches.map((m: ReferenceMatch) => ({
          id: m.id,
          paidAt: m.paidAt.toISOString(),
          amount: m.amount,
          currency: m.currency,
          receiptNumber: m.receiptNumber,
        })),
      });
    }

    return {
      paymentMethodId: medium?.id ?? null,
      method: medium ? legacyPaymentMethodOf(medium.kind) : input.method,
      reference,
      referenceNormalized,
      duplicateReferenceReason: matches.length > 0 ? reason : null,
      duplicateReferenceOf: matches.map((m) => m.id),
      adjustments: await this.adjustmentsOf(medium, charge),
    };
  }

  private async adjustmentsOf(
    medium: ClinicPaymentMethodEntity | null,
    charge: PaymentCharge | undefined,
  ): Promise<ComputedAdjustment[]> {
    const rules = medium?.adjustments.filter((a) => a.active) ?? [];
    if (!charge || rules.length === 0) return [];
    const table = await this.digits.table([charge.currency]);
    return computePaymentAdjustments(
      rules,
      charge.amount,
      charge.currency,
      table.roundingDigits(charge.currency),
    );
  }

  /**
   * Con `paymentMethodId`, ese medio (activo y de esta clínica, o 400). Solo
   * con `method` (cliente o réplica anteriores), su medio inicial si existe.
   */
  private async medium(
    input: PaymentMethodRequest,
  ): Promise<ClinicPaymentMethodEntity | null> {
    if (input.paymentMethodId) {
      const found = await this.methods.findById(input.paymentMethodId);
      if (!found)
        throw new BadRequestException(PAYMENT_METHOD_NOT_FOUND_MESSAGE);
      if (!found.active) {
        throw new BadRequestException(PAYMENT_METHOD_INACTIVE_MESSAGE);
      }
      return found;
    }
    return input.method ? this.methods.findByLegacyMethod(input.method) : null;
  }
}
