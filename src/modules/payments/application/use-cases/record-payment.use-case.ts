import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type {
  CivilPaidDay,
  CreatePaymentRepoInput,
  PaymentRepository,
} from '../../domain/ports/payment-repository.port';
import { parseCivilDate } from '../../../../shared/time/civil-day';
import { Payment } from '../../domain/entities/payment.entity';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { CURRENCY_WHITELIST } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import type { CurrencyWhitelist } from '../../../treatment-plans/domain/ports/currency-whitelist.port';

// NOTE: deliberately NO `patientId`/`treatmentPlanId` field on the input
// object itself (`treatmentPlanId` is a separate `execute()` argument,
// `patientId` is ALWAYS derived from the plan) — same convention as
// CreateSaleInput never accepting `total`/`amount` from the caller.
export interface RecordPaymentInput {
  amount: number;
  currency: string;
  /**
   * Instante (ISO con hora, o `Date`) o solo el día civil `YYYY-MM-DD`, que
   * se guarda al mediodía de la sede del abono (DX-097).
   */
  paidAt: string | Date;
  method?: PaymentMethod;
  notes?: string;
}

const CIVIL_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
// Una hora sin `Z` ni desfase la leería `new Date` en la zona del SERVIDOR.
const EXPLICIT_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * ¿Es el instante exactamente la medianoche UTC? Es lo que mandaba la web
 * anterior a DX-097 (`new Date('YYYY-MM-DD').toISOString()`) para el día
 * elegido, y la misma regla con la que la migración
 * 20261017113000_payments_civil_day_noon reinterpretó los abonos guardados.
 * Compatibilidad de escritura con pestañas abiertas con el bundle viejo:
 * retirar cuando ningún cliente anterior a DX-097 siga en uso (p. ej. un mes
 * después del despliegue, revisando el log de acceso).
 */
function isUtcMidnight(instant: Date): boolean {
  return instant.getTime() % (24 * 60 * 60 * 1000) === 0;
}

/**
 * DX-097: `YYYY-MM-DD` es un día civil (el formulario de abono), y también una
 * medianoche UTC exacta (clientes antiguos, ver `isUtcMidnight`); cualquier
 * otra fecha ISO con hora es un instante y debe traer `Z` o desfase. Sin esta
 * distinción, `new Date` leería el día como medianoche UTC, que en Bogotá es
 * la tarde del día ANTERIOR.
 */
function normalizePaidAt(value: string | Date): Date | CivilPaidDay {
  if (typeof value === 'string' && CIVIL_DATE_SHAPE.test(value)) {
    const civilDate = parseCivilDate(value);
    if (civilDate === null) {
      throw new BadRequestException('paidAt must be a valid date');
    }
    return { civilDate };
  }
  if (typeof value === 'string' && !EXPLICIT_OFFSET.test(value.trim())) {
    throw new BadRequestException(
      'paidAt with a time must include Z or a UTC offset',
    );
  }
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new BadRequestException('paidAt must be a valid date');
  }
  if (isUtcMidnight(instant)) {
    return { civilDate: instant.toISOString().slice(0, 10) };
  }
  return instant;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Idempotency-Key must be a UUID (the client contract). Validated here rather
// than via a DTO because it's a header, not a body field — same reason
// tenant/createdById live outside RecordPaymentInput.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RecordPaymentUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly repo: PaymentRepository,
    // Concrete class (not an interface port) injected directly, same
    // cross-module DI pattern as GetSalesTotalsUseCase injecting
    // ConvertAmountUseCase: reused so "does the plan exist" (NotFound if
    // absent/soft-deleted/cross-tenant) and "what's its patientId" live in
    // exactly one place, never re-implemented here.
    private readonly getTreatmentPlan: GetTreatmentPlanUseCase,
    @Inject(CURRENCY_WHITELIST)
    private readonly whitelist: CurrencyWhitelist,
  ) {}

  /**
   * `createdById` is a separate argument (not part of `input`) — it comes
   * from the guarded request context (`req.user`), never the client body,
   * same rationale as the tenant itself (see CreateSaleUseCase).
   */
  async execute(
    treatmentPlanId: string,
    input: RecordPaymentInput,
    createdById?: string,
    idempotencyKey?: string,
  ): Promise<Payment> {
    // Idempotency short-circuit FIRST — before any validation or plan lookup: a
    // replay must be cheap and must NOT re-run "does the plan still exist" (a
    // plan voided AFTER the original payment would otherwise make an honest
    // retry 404). Blank/whitespace header == no key (today's behavior).
    const key = idempotencyKey?.trim() ? idempotencyKey.trim() : undefined;
    if (key !== undefined) {
      if (!UUID_RE.test(key)) {
        throw new BadRequestException('Idempotency-Key must be a UUID');
      }
      const existing = await this.repo.findByIdempotencyKey(key);
      if (existing) {
        return existing;
      }
    }

    if (!isFinitePositive(input.amount)) {
      throw new BadRequestException('amount must be a finite number > 0');
    }

    if (!input.currency || input.currency.trim() === '') {
      throw new BadRequestException('currency is required');
    }
    const currency = input.currency.trim().toUpperCase();
    if (!(await this.whitelist.has(currency))) {
      throw new BadRequestException(`Unknown currency: ${currency}`);
    }

    const paidAt = normalizePaidAt(input.paidAt);

    // Throws NotFoundException when the plan is absent, soft-deleted, or
    // belongs to another tenant — never re-derived here.
    const plan = await this.getTreatmentPlan.execute(treatmentPlanId);

    const repoInput: CreatePaymentRepoInput = {
      treatmentPlanId,
      patientId: plan.patientId,
      amount: input.amount,
      currency,
      paidAt,
      method: input.method,
      notes: input.notes,
      createdById,
      idempotencyKey: key,
    };

    return this.repo.create(repoInput);
  }
}
