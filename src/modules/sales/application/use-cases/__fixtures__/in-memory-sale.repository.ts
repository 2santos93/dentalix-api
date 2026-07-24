import { Sale, SaleWithLineItems } from '../../../domain/entities/sale.entity';
import { SaleLineItem } from '../../../domain/entities/sale-line-item.entity';
import {
  CreateSaleRepoInput,
  ListSalesByRangeParams,
  ListSalesForTotalsParams,
  SaleRepository,
  SaleTotalsRow,
} from '../../../domain/ports/sale-repository.port';

// `Sale` (the API-facing entity) deliberately has no `deletedAt` field —
// same convention as Appointment/TreatmentPlan. The fake still has to
// honour "non-deleted only" like the real Prisma repo, so it tracks
// `deletedAt` on the stored row and strips it via `toEntity` (mirrors
// `mapToEntity` in prisma-sale.repository.ts).
type StoredSale = Sale & { deletedAt: Date | null };

let seq = 0;
const NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * Real in-memory fake for `SaleRepository` — implements ACTUAL filtering
 * logic (not a canned stub returning a fixed array), so use-case specs
 * built on it genuinely exercise `deletedAt:null` filtering, range
 * scoping, and DESC ordering. Mirrors `PrismaSaleRepository`'s semantics.
 */
export class InMemorySaleRepository implements SaleRepository {
  private readonly sales: StoredSale[] = [];
  private readonly lineItems: SaleLineItem[] = [];

  /** Test helper: seed a sale (+ optional lines) directly, bypassing
   * use-case validation. */
  seedSale(
    overrides: Partial<StoredSale> = {},
    lines: Array<Partial<SaleLineItem>> = [],
  ): Sale {
    const id = overrides.id ?? `sale-seed-${++seq}`;
    const row: StoredSale = {
      id,
      tenantId: overrides.tenantId ?? 't1',
      patientId: overrides.patientId ?? null,
      currency: overrides.currency ?? 'USD',
      total: overrides.total ?? 0,
      paidAt: overrides.paidAt ?? NOW,
      paymentMethod: overrides.paymentMethod ?? null,
      notes: overrides.notes ?? null,
      createdById: overrides.createdById ?? null,
      createdAt: overrides.createdAt ?? NOW,
      updatedAt: overrides.updatedAt ?? NOW,
      deletedAt: overrides.deletedAt ?? null,
    };
    this.sales.push(row);

    for (const line of lines) {
      this.lineItems.push({
        id: line.id ?? `line-seed-${++seq}`,
        tenantId: line.tenantId ?? row.tenantId,
        saleId: id,
        description: line.description ?? 'seeded line',
        catalogItemId: line.catalogItemId ?? null,
        treatmentPlanItemId: line.treatmentPlanItemId ?? null,
        unitPrice: line.unitPrice ?? 0,
        quantity: line.quantity ?? 1,
        amount: line.amount ?? 0,
        createdAt: line.createdAt ?? NOW,
        updatedAt: line.updatedAt ?? NOW,
      });
    }

    return this.toEntity(row);
  }

  // Explicit field-by-field mapping (mirrors `mapToEntity` in the Prisma
  // repo) rather than destructuring off `deletedAt`, so it stays obviously
  // in sync with the entity shape.
  private toEntity(row: StoredSale): Sale {
    return {
      id: row.id,
      tenantId: row.tenantId,
      patientId: row.patientId,
      currency: row.currency,
      total: row.total,
      paidAt: row.paidAt,
      paymentMethod: row.paymentMethod,
      notes: row.notes,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toEntityWithLines(row: StoredSale): SaleWithLineItems {
    return {
      ...this.toEntity(row),
      lineItems: this.lineItems.filter((line) => line.saleId === row.id),
    };
  }

  create(input: CreateSaleRepoInput): Promise<SaleWithLineItems> {
    const id = `sale-${++seq}`;
    const row: StoredSale = {
      id,
      tenantId: 't1',
      patientId: input.patientId ?? null,
      currency: input.currency,
      total: input.total,
      paidAt: input.paidAt,
      paymentMethod: input.paymentMethod ?? null,
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    this.sales.push(row);

    for (const line of input.lineItems) {
      this.lineItems.push({
        id: `line-${++seq}`,
        tenantId: row.tenantId,
        saleId: id,
        description: line.description,
        catalogItemId: line.catalogItemId ?? null,
        treatmentPlanItemId: line.treatmentPlanItemId ?? null,
        unitPrice: line.unitPrice,
        quantity: line.quantity,
        amount: line.amount,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }

    return Promise.resolve(this.toEntityWithLines(row));
  }

  findById(id: string): Promise<SaleWithLineItems | null> {
    const row = this.sales.find((s) => s.id === id && s.deletedAt === null);
    return Promise.resolve(row ? this.toEntityWithLines(row) : null);
  }

  listByRange(params: ListSalesByRangeParams): Promise<Sale[]> {
    const rows = this.sales
      .filter((s) => s.deletedAt === null)
      .filter((s) => (params.from ? s.paidAt >= params.from : true))
      .filter((s) => (params.to ? s.paidAt < params.to : true))
      .filter((s) =>
        params.patientId ? s.patientId === params.patientId : true,
      )
      .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())
      .map((s) => this.toEntity(s));
    return Promise.resolve(rows);
  }

  softDelete(id: string): Promise<void> {
    const row = this.sales.find((s) => s.id === id && s.deletedAt === null);
    if (!row) {
      return Promise.reject(
        new Error(`InMemorySaleRepository.softDelete: not found ${id}`),
      );
    }
    row.deletedAt = NOW;
    return Promise.resolve();
  }

  listForTotals(params: ListSalesForTotalsParams): Promise<SaleTotalsRow[]> {
    const rows: SaleTotalsRow[] = this.sales
      .filter((s) => s.deletedAt === null)
      .filter((s) => s.paidAt >= params.from && s.paidAt < params.to)
      .map((s) => ({
        id: s.id,
        currency: s.currency,
        total: s.total,
        paidAt: s.paidAt,
      }));
    return Promise.resolve(rows);
  }

  /** Test helper: raw access for assertions on stored lines. */
  getLineItems(): SaleLineItem[] {
    return this.lineItems;
  }
}
