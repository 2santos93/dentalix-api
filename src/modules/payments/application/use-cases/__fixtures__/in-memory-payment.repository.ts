import { Payment } from '../../../domain/entities/payment.entity';
import type { IdempotentPayment } from '../../../domain/idempotency';
import {
  CashRegisterPage,
  CivilPaidDay,
  CreatePaymentRepoInput,
  ListCashRegisterParams,
  ListPaymentsReceivedInRangeParams,
  OpeningBalanceTarget,
  PaymentRepository,
  PaymentVoidAudit,
  PaymentVoidTarget,
  ReceivedPayment,
} from '../../../domain/ports/payment-repository.port';
import { civilDateIn, civilNoonIn } from '../../../../../shared/time/civil-day';
import type { RegionalFormat } from '../../../../../shared/format/regional-format';
import { requireLocationFormat } from '../../../../../shared/locations/location-regional';

// `Payment` (the API-facing entity) deliberately has no `deletedAt` field —
// same convention as Sale/TreatmentPlan. The fake still has to honour
// "non-deleted only" like the real Prisma repo, so it tracks `deletedAt` on
// the stored row and strips it via `toEntity` (mirrors `mapToEntity` in
// prisma-payment.repository.ts).
type StoredPayment = Omit<Payment, 'paidOn' | 'receiptNumber'> & {
  deletedAt: Date | null;
  idempotencyKey: string | null;
  requestFingerprint: string | null;
  voidAudit: PaymentVoidAudit | null;
};

let seq = 0;
const NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * Real in-memory fake for `PaymentRepository` — implements ACTUAL filtering
 * logic (not a canned stub returning a fixed array), so use-case specs built
 * on it genuinely exercise `deletedAt:null` filtering, plan scoping, range
 * scoping, and DESC ordering. Mirrors `PrismaPaymentRepository`'s semantics.
 */
export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly payments: StoredPayment[] = [];

  /** Formato y reloj de la sede de escritura (G1-B); `null` = sin configurar. */
  locale: string | null = 'es-CO';
  hourCycle: string | null = 'h23';

  /** Test helper: lo último que recibió `create` (DX-136: el saldo del recibo). */
  lastCreateInput: CreatePaymentRepoInput | null = null;

  /**
   * @param timeZone zona de la sede de TODOS los abonos de este fake (el real
   * la lee del horario de la sede de cada abono).
   */
  constructor(private readonly timeZone = 'America/Bogota') {}

  /** Test helper: el rastro de anulación guardado, o `null` si sigue activo. */
  voidAuditOf(id: string): PaymentVoidAudit | null {
    return this.payments.find((p) => p.id === id)?.voidAudit ?? null;
  }

  /** Test helper: seed a payment row directly, bypassing use-case validation. */
  seedPayment(overrides: Partial<StoredPayment> = {}): Payment {
    const row: StoredPayment = {
      id: overrides.id ?? `payment-seed-${++seq}`,
      tenantId: overrides.tenantId ?? 't1',
      treatmentPlanId:
        overrides.treatmentPlanId === undefined
          ? 'plan-1'
          : overrides.treatmentPlanId,
      openingBalanceId: overrides.openingBalanceId ?? null,
      patientId: overrides.patientId ?? 'p1',
      amount: overrides.amount ?? 0,
      currency: overrides.currency ?? 'USD',
      paidAt: overrides.paidAt ?? NOW,
      method: overrides.method ?? null,
      notes: overrides.notes ?? null,
      createdById: overrides.createdById ?? null,
      createdAt: overrides.createdAt ?? NOW,
      updatedAt: overrides.updatedAt ?? NOW,
      idempotencyKey: overrides.idempotencyKey ?? null,
      requestFingerprint: overrides.requestFingerprint ?? null,
      deletedAt: overrides.deletedAt ?? null,
      voidAudit: overrides.voidAudit ?? null,
    };
    this.payments.push(row);
    return this.toEntity(row);
  }

  // Explicit field-by-field mapping (mirrors `mapToEntity` in the Prisma
  // repo) rather than destructuring off `deletedAt`, so it stays obviously
  // in sync with the entity shape.
  private toEntity(row: StoredPayment): Payment {
    return {
      id: row.id,
      tenantId: row.tenantId,
      treatmentPlanId: row.treatmentPlanId,
      openingBalanceId: row.openingBalanceId,
      patientId: row.patientId,
      amount: row.amount,
      currency: row.currency,
      paidAt: row.paidAt,
      paidOn: civilDateIn(row.paidAt, this.timeZone),
      method: row.method,
      notes: row.notes,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      receiptNumber: null,
    };
  }

  resolvePaidOn(paidAt: Date | CivilPaidDay): Promise<string> {
    return Promise.resolve(
      paidAt instanceof Date
        ? civilDateIn(paidAt, this.timeZone)
        : paidAt.civilDate,
    );
  }

  writeLocationFormat(): Promise<RegionalFormat> {
    return Promise.resolve().then(() =>
      requireLocationFormat({
        id: 'loc-1',
        locale: this.locale,
        hourCycle: this.hourCycle,
      }),
    );
  }

  create(input: CreatePaymentRepoInput): Promise<Payment> {
    this.lastCreateInput = input;
    const row: StoredPayment = {
      id: `payment-${++seq}`,
      tenantId: 't1',
      treatmentPlanId: input.treatmentPlanId,
      openingBalanceId: input.openingBalanceId ?? null,
      patientId: input.patientId,
      amount: input.amount,
      currency: input.currency,
      paidAt:
        input.paidAt instanceof Date
          ? input.paidAt
          : civilNoonIn(input.paidAt.civilDate, this.timeZone),
      method: input.method ?? null,
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
      createdAt: NOW,
      updatedAt: NOW,
      idempotencyKey: input.idempotencyKey ?? null,
      requestFingerprint: input.requestFingerprint ?? null,
      deletedAt: null,
      voidAudit: null,
    };
    this.payments.push(row);
    return Promise.resolve(this.toEntity(row));
  }

  /** Test helper: saldos migrados que conoce el fake (DX-262). */
  readonly openingBalances = new Map<
    string,
    { id: string; patientId: string; currency: string; amount: number }
  >();

  findOpeningBalance(id: string): Promise<OpeningBalanceTarget | null> {
    const balance = this.openingBalances.get(id);
    if (!balance) return Promise.resolve(null);
    const paid = this.payments
      .filter(
        (p) =>
          p.openingBalanceId === id &&
          p.deletedAt === null &&
          p.currency === balance.currency,
      )
      .reduce((sum, p) => sum + Math.round(p.amount * 100), 0);
    return Promise.resolve({ ...balance, paid: paid / 100 });
  }

  listByOpeningBalance(openingBalanceId: string): Promise<Payment[]> {
    return Promise.resolve(
      this.payments
        .filter(
          (p) =>
            p.openingBalanceId === openingBalanceId && p.deletedAt === null,
        )
        .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())
        .map((p) => this.toEntity(p)),
    );
  }

  findById(id: string): Promise<Payment | null> {
    const row = this.payments.find((p) => p.id === id && p.deletedAt === null);
    return Promise.resolve(row ? this.toEntity(row) : null);
  }

  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<IdempotentPayment | null> {
    // Mirrors PrismaPaymentRepository.findByIdempotencyKey: match by key only
    // (RLS scopes tenant in the real repo). Deliberately NOT filtered by
    // deletedAt, so a replay resolves to the same row even if voided.
    const row = this.payments.find((p) => p.idempotencyKey === idempotencyKey);
    return Promise.resolve(
      row
        ? {
            payment: this.toEntity(row),
            requestFingerprint: row.requestFingerprint,
          }
        : null,
    );
  }

  listByPlan(treatmentPlanId: string): Promise<Payment[]> {
    const rows = this.payments
      .filter(
        (p) => p.treatmentPlanId === treatmentPlanId && p.deletedAt === null,
      )
      .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())
      .map((p) => this.toEntity(p));
    return Promise.resolve(rows);
  }

  listByPatient(patientId: string): Promise<Payment[]> {
    const rows = this.payments
      .filter((p) => p.patientId === patientId && p.deletedAt === null)
      .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())
      .map((p) => this.toEntity(p));
    return Promise.resolve(rows);
  }

  findVoidTarget(id: string): Promise<PaymentVoidTarget | null> {
    const row = this.payments.find((p) => p.id === id && p.deletedAt === null);
    return Promise.resolve(
      row
        ? {
            id: row.id,
            createdById: row.createdById,
            createdAt: row.createdAt,
            timeZone: this.timeZone,
          }
        : null,
    );
  }

  softDelete(id: string, audit: PaymentVoidAudit): Promise<boolean> {
    // Atomic check-and-set (mirrors PrismaPaymentRepository.softDelete's
    // `updateMany({ where: { id, deletedAt: null }, ... })`): find + mutate
    // in one synchronous step, never a separate find then update, so the
    // caller gets a single true/false answer instead of a stale read.
    const row = this.payments.find((p) => p.id === id && p.deletedAt === null);
    if (!row) {
      return Promise.resolve(false);
    }
    row.deletedAt = audit.voidedAt;
    row.voidAudit = audit;
    return Promise.resolve(true);
  }

  // Mismo criterio que el repo real: el día civil de `paidAt` en la zona de
  // la sede (aquí, la única del fake), comparado como texto YYYY-MM-DD.
  listReceivedInRange(
    params: ListPaymentsReceivedInRangeParams,
  ): Promise<ReceivedPayment[]> {
    const rows = this.payments
      .filter((p) => p.deletedAt === null)
      .map((p) => this.toEntity(p))
      .filter((p) => p.paidOn >= params.from && p.paidOn <= params.to);
    return Promise.resolve(rows);
  }

  // La caja une paciente, plan y sede, que este fake no modela: ningún caso de
  // uso que lo use la necesita. ListCashPaymentsUseCase se prueba con un espía
  // que sobreescribe este método (ver list-cash-payments.use-case.spec.ts) y la
  // consulta real, con sus joins, en test/cash-register.e2e-spec.ts.
  listForCashRegister(
    params: ListCashRegisterParams,
  ): Promise<CashRegisterPage> {
    return Promise.reject(
      new Error(
        `listForCashRegister(${params.from}) not implemented in this fake`,
      ),
    );
  }
}
