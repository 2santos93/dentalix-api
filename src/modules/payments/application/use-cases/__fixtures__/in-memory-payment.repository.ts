import { Payment } from '../../../domain/entities/payment.entity';
import {
  CreatePaymentRepoInput,
  ListPaymentsReceivedInRangeParams,
  PaymentRepository,
} from '../../../domain/ports/payment-repository.port';

// `Payment` (the API-facing entity) deliberately has no `deletedAt` field —
// same convention as Sale/TreatmentPlan. The fake still has to honour
// "non-deleted only" like the real Prisma repo, so it tracks `deletedAt` on
// the stored row and strips it via `toEntity` (mirrors `mapToEntity` in
// prisma-payment.repository.ts).
type StoredPayment = Payment & { deletedAt: Date | null };

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

  /** Test helper: seed a payment row directly, bypassing use-case validation. */
  seedPayment(overrides: Partial<StoredPayment> = {}): Payment {
    const row: StoredPayment = {
      id: overrides.id ?? `payment-seed-${++seq}`,
      tenantId: overrides.tenantId ?? 't1',
      treatmentPlanId: overrides.treatmentPlanId ?? 'plan-1',
      patientId: overrides.patientId ?? 'p1',
      amount: overrides.amount ?? 0,
      currency: overrides.currency ?? 'USD',
      paidAt: overrides.paidAt ?? NOW,
      method: overrides.method ?? null,
      notes: overrides.notes ?? null,
      createdById: overrides.createdById ?? null,
      createdAt: overrides.createdAt ?? NOW,
      updatedAt: overrides.updatedAt ?? NOW,
      deletedAt: overrides.deletedAt ?? null,
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
      patientId: row.patientId,
      amount: row.amount,
      currency: row.currency,
      paidAt: row.paidAt,
      method: row.method,
      notes: row.notes,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  create(input: CreatePaymentRepoInput): Promise<Payment> {
    const row: StoredPayment = {
      id: `payment-${++seq}`,
      tenantId: 't1',
      treatmentPlanId: input.treatmentPlanId,
      patientId: input.patientId,
      amount: input.amount,
      currency: input.currency,
      paidAt: input.paidAt,
      method: input.method ?? null,
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    this.payments.push(row);
    return Promise.resolve(this.toEntity(row));
  }

  findById(id: string): Promise<Payment | null> {
    const row = this.payments.find((p) => p.id === id && p.deletedAt === null);
    return Promise.resolve(row ? this.toEntity(row) : null);
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

  softDelete(id: string): Promise<void> {
    const row = this.payments.find((p) => p.id === id && p.deletedAt === null);
    if (!row) {
      return Promise.reject(
        new Error(`InMemoryPaymentRepository.softDelete: not found ${id}`),
      );
    }
    row.deletedAt = NOW;
    return Promise.resolve();
  }

  listReceivedInRange(
    params: ListPaymentsReceivedInRangeParams,
  ): Promise<Payment[]> {
    const rows = this.payments
      .filter((p) => p.deletedAt === null)
      .filter((p) => p.paidAt >= params.from && p.paidAt < params.to)
      .map((p) => this.toEntity(p));
    return Promise.resolve(rows);
  }
}
