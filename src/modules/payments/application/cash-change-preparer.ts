import {
  BadRequestException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PAYMENT_METHOD_REPOSITORY,
  type PaymentMethodRepository,
} from '../../payment-methods/domain/ports/payment-method-repository.port';
import {
  PAYMENT_METHOD_INACTIVE_MESSAGE,
  PAYMENT_METHOD_NOT_FOUND_MESSAGE,
  legacyPaymentMethodOf,
  normalizeReference,
  referenceError,
} from '../../payment-methods/domain/payment-method-rules';
import {
  CURRENCY_DIGITS_CATALOG,
  type CurrencyDigitsCatalog,
} from '../../../shared/money/currency-digits';
import { fitsRoundingDigits } from '../../../shared/money/line-rounding';
import { fromCents, toCents } from '../../../shared/money/money';
import {
  CURRENCY_WHITELIST,
  type CurrencyWhitelist,
} from '../../treatment-plans/domain/ports/currency-whitelist.port';
import {
  CURRENCY_REQUIRED_MESSAGE,
  PAYMENT_AMOUNT_MESSAGE,
  UNKNOWN_CURRENCY_MESSAGE,
} from '../../../shared/money/currency-messages';
import { ConvertAmountUseCase } from '../../exchange/application/use-cases/convert-amount.use-case';
import { convertWithQuote } from '../../exchange/domain/exchange-rate-quote';
import { freezePaymentRate } from './payment-exchange-rate';
import {
  CASH_CHANGE_REMAINDER,
  CHANGE_LINES_LIMIT_MESSAGE,
  CHANGE_LINES_MAX,
  CHANGE_NOT_CASH_MESSAGE,
  CHANGE_REMAINDER_WITH_ADJUSTMENTS_MESSAGE,
  CHANGE_WITHOUT_TENDERED_MESSAGE,
  REMAINDER_WITHOUT_TENDERED_MESSAGE,
  centsText,
  changeDigitsMessage,
  changeExceedsMessage,
  changeLineTooSmallMessage,
  changeRateMissingMessage,
  changeRemainderMessage,
  settleCashChange,
  tenderedBelowCollectedMessage,
  tenderedDigitsMessage,
  type PaymentCashChange,
  type PreparedChangeLine,
} from '../domain/cash-change';
import type { PaymentMethod } from '@prisma/client';

/** Una línea de vuelto tal como llega del cliente. */
export interface CashChangeLineRequest {
  paymentMethodId: string;
  currency: string;
  amount: number;
  reference?: string;
}

/** Lo que el cliente manda del vuelto (todo opcional: sin nada, como hoy). */
export interface CashChangeRequest {
  tendered?: number;
  change?: CashChangeLineRequest[];
  changeRemainderToCredit?: boolean;
}

/** ¿Trae la petición algo del vuelto? Sin nada, el cobro es el de hoy. */
export function hasCashChange(input: CashChangeRequest): boolean {
  return (
    input.tendered !== undefined ||
    (input.change?.length ?? 0) > 0 ||
    input.changeRemainderToCredit === true
  );
}

/**
 * DX-570: valida y prepara el vuelto de un abono en efectivo FUERA de su
 * transacción (las tasas pueden pedir un proveedor externo), con el abono ya
 * resuelto (`prepareLine`: medio, ajustes y día civil): medio y referencia de
 * cada línea (la misma regla que el abono, DX-377), decimales de cada moneda
 * (DX-340), la tasa del día congelada (DX-375) y el cuadre. Devuelve el vuelto
 * y el importe final del abono (más el resto, si se confirmó).
 */
@Injectable()
export class CashChangePreparer {
  constructor(
    @Inject(PAYMENT_METHOD_REPOSITORY)
    private readonly methods: PaymentMethodRepository,
    @Inject(CURRENCY_WHITELIST)
    private readonly whitelist: CurrencyWhitelist,
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly digits: CurrencyDigitsCatalog,
    private readonly convertAmount: ConvertAmountUseCase,
  ) {}

  /**
   * Las comprobaciones que no necesitan el medio resuelto (400 tempranos):
   * forma del vuelto, sin tocar nada.
   */
  assertShape(input: CashChangeRequest): void {
    const lines = input.change ?? [];
    if (lines.length > CHANGE_LINES_MAX) {
      throw new BadRequestException(CHANGE_LINES_LIMIT_MESSAGE);
    }
    if (input.tendered === undefined) {
      if (lines.length > 0) {
        throw new BadRequestException(CHANGE_WITHOUT_TENDERED_MESSAGE);
      }
      if (input.changeRemainderToCredit === true) {
        throw new BadRequestException(REMAINDER_WITHOUT_TENDERED_MESSAGE);
      }
    }
  }

  async prepare(
    input: CashChangeRequest,
    payment: {
      amount: number;
      currency: string;
      method: PaymentMethod | undefined | null;
      /** Lo cobrado: importe + ajustes por medio de pago (DX-516). */
      collected: number;
      hasAdjustments: boolean;
      /** Día civil del abono en su sede: el de la tasa. */
      paidOn: string;
    },
  ): Promise<{ change: PaymentCashChange; amount: number }> {
    this.assertShape(input);
    const tendered = input.tendered as number;
    if (payment.method !== 'CASH') {
      throw new BadRequestException(CHANGE_NOT_CASH_MESSAGE);
    }
    const requests = input.change ?? [];
    const currencies = await Promise.all(
      requests.map((line) => this.validCurrency(line)),
    );
    const table = await this.digits.table([payment.currency, ...currencies]);
    const payDigits = table.roundingDigits(payment.currency);
    if (!(tendered > 0) || !Number.isFinite(tendered)) {
      throw new BadRequestException(PAYMENT_AMOUNT_MESSAGE);
    }
    if (!fitsRoundingDigits(tendered, payDigits)) {
      throw new BadRequestException(
        tenderedDigitsMessage(payment.currency, payDigits),
      );
    }

    const lines: PreparedChangeLine[] = [];
    for (const [index, request] of requests.entries()) {
      const currency = currencies[index];
      const digits = table.roundingDigits(currency);
      if (!fitsRoundingDigits(request.amount, digits)) {
        throw new BadRequestException(changeDigitsMessage(currency, digits));
      }
      lines.push(
        await this.line(index + 1, request, currency, payment.currency, {
          paidOn: payment.paidOn,
        }),
      );
    }

    const outcome = settleCashChange({
      tenderedCents: toCents(tendered),
      collectedCents: toCents(payment.collected),
      changeEquivalentCents: lines.map((l) => toCents(l.equivalentAmount)),
      remainderToCredit: input.changeRemainderToCredit === true,
      hasAdjustments: payment.hasAdjustments,
    });
    switch (outcome.kind) {
      case 'tendered-below-collected':
        throw new BadRequestException(
          tenderedBelowCollectedMessage(
            centsText(toCents(payment.collected)),
            payment.currency,
          ),
        );
      case 'change-exceeds':
        throw new UnprocessableEntityException(
          changeExceedsMessage(
            centsText(outcome.changeCents),
            centsText(outcome.dueCents),
            payment.currency,
          ),
        );
      case 'remainder-unconfirmed':
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: CASH_CHANGE_REMAINDER,
          message: changeRemainderMessage(
            centsText(outcome.remainderCents),
            payment.currency,
          ),
          remainder: fromCents(outcome.remainderCents),
          currency: payment.currency,
        });
      case 'remainder-with-adjustments':
        throw new UnprocessableEntityException(
          CHANGE_REMAINDER_WITH_ADJUSTMENTS_MESSAGE,
        );
      case 'ok':
        break;
    }
    const remainder = fromCents(outcome.remainderCents);
    return {
      change: { tendered, remainderToCredit: remainder, lines },
      amount: fromCents(toCents(payment.amount) + outcome.remainderCents),
    };
  }

  private async validCurrency(line: CashChangeLineRequest): Promise<string> {
    if (!(typeof line.amount === 'number' && line.amount > 0)) {
      throw new BadRequestException(PAYMENT_AMOUNT_MESSAGE);
    }
    if (!line.currency?.trim()) {
      throw new BadRequestException(CURRENCY_REQUIRED_MESSAGE);
    }
    const currency = line.currency.trim().toUpperCase();
    if (!(await this.whitelist.has(currency))) {
      throw new BadRequestException(UNKNOWN_CURRENCY_MESSAGE);
    }
    return currency;
  }

  private async line(
    number: number,
    request: CashChangeLineRequest,
    currency: string,
    paymentCurrency: string,
    day: { paidOn: string },
  ): Promise<PreparedChangeLine> {
    // El medio en ESTA clínica (RLS), activo; la referencia, si la pide.
    const medium = await this.methods.findById(request.paymentMethodId);
    if (!medium)
      throw new BadRequestException(PAYMENT_METHOD_NOT_FOUND_MESSAGE);
    if (!medium.active) {
      throw new BadRequestException(PAYMENT_METHOD_INACTIVE_MESSAGE);
    }
    const error = referenceError(request.reference, medium.requiresReference);
    if (error !== null) throw new BadRequestException(error);
    const referenceNormalized = normalizeReference(request.reference);
    const reference =
      referenceNormalized === null ? null : (request.reference?.trim() ?? null);

    if (currency === paymentCurrency) {
      return {
        line: number,
        paymentMethodId: medium.id,
        paymentMethodName: medium.name,
        method: legacyPaymentMethodOf(medium.kind),
        currency,
        amount: request.amount,
        reference,
        referenceNormalized,
        equivalentAmount: request.amount,
        rate: null,
      };
    }
    // La tasa del día del abono en su sede, con la fuente de la clínica
    // (DX-375): la misma que congelaría un abono en esa moneda.
    const frozen = await freezePaymentRate(this.convertAmount, {
      currency,
      targetCurrency: paymentCurrency,
      paidOn: day.paidOn,
    });
    if (!frozen) {
      throw new UnprocessableEntityException(
        changeRateMissingMessage(currency, paymentCurrency),
      );
    }
    const equivalentAmount = convertWithQuote(request.amount, {
      from: currency,
      to: paymentCurrency,
      fromPerBase: frozen.fromPerBase,
      toPerBase: frozen.toPerBase,
    });
    if (!(equivalentAmount > 0)) {
      throw new UnprocessableEntityException(changeLineTooSmallMessage(number));
    }
    return {
      line: number,
      paymentMethodId: medium.id,
      paymentMethodName: medium.name,
      method: legacyPaymentMethodOf(medium.kind),
      currency,
      amount: request.amount,
      reference,
      referenceNormalized,
      equivalentAmount,
      rate: {
        fromPerBase: frozen.fromPerBase,
        toPerBase: frozen.toPerBase,
        source: frozen.source,
        date: frozen.date,
      },
    };
  }
}
