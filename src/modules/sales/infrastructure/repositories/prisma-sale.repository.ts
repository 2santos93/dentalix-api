import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CreateSaleRepoInput,
  ListSalesByRangeParams,
  ListSalesForTotalsParams,
  SaleRepository,
  SaleTotalsRow,
} from '../../domain/ports/sale-repository.port';
import { Sale, SaleWithLineItems } from '../../domain/entities/sale.entity';

type PrismaSale = Prisma.SaleGetPayload<Record<string, never>>;
type PrismaSaleLineItem = Prisma.SaleLineItemGetPayload<Record<string, never>>;
type PrismaSaleWithLineItems = Prisma.SaleGetPayload<{
  include: { lineItems: true };
}>;

function mapToEntity(sale: PrismaSale): Sale {
  return {
    id: sale.id,
    tenantId: sale.tenantId,
    patientId: sale.patientId,
    currency: sale.currency,
    total: sale.total.toNumber(),
    paidAt: sale.paidAt,
    paymentMethod: sale.paymentMethod,
    notes: sale.notes,
    createdById: sale.createdById,
    createdAt: sale.createdAt,
    updatedAt: sale.updatedAt,
  };
}

// `unitPrice`/`amount` are Prisma `Decimal` at the DB layer; the API-facing
// entity exposes them as plain `number` — same convention as
// `PrismaTreatmentPlanRepository.mapItemToEntity` for `price`. There is no
// `deletedAt` to strip here: `SaleLineItem` has no such column (see
// `SaleLineItem` entity doc — lines are never independently soft-deleted).
function mapLineItemToEntity(line: PrismaSaleLineItem) {
  return {
    id: line.id,
    tenantId: line.tenantId,
    saleId: line.saleId,
    description: line.description,
    catalogItemId: line.catalogItemId,
    treatmentPlanItemId: line.treatmentPlanItemId,
    unitPrice: line.unitPrice.toNumber(),
    quantity: line.quantity,
    amount: line.amount.toNumber(),
    createdAt: line.createdAt,
    updatedAt: line.updatedAt,
  };
}

function mapToEntityWithLineItems(
  sale: PrismaSaleWithLineItems,
): SaleWithLineItems {
  return {
    ...mapToEntity(sale),
    lineItems: sale.lineItems.map(mapLineItemToEntity),
  };
}

@Injectable()
export class PrismaSaleRepository implements SaleRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `tenantId` is NOT NULL at the DB level with no column default that
   * autofills from the RLS GUC, so — unlike a plain SELECT/UPDATE, which
   * RLS filters transparently — an INSERT still needs the app to supply it
   * explicitly (for BOTH the sale row and its line items). We never take it
   * from the input (never from the client); we read it from the same
   * request-scoped context that `runWithTenant(fn)` uses to set
   * `app.current_tenant`, so the value written always matches the GUC the
   * WITH CHECK policy validates against (same convention as
   * PrismaTreatmentPlanRepository / PrismaAppointmentRepository).
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  /**
   * Creates the Sale and its line items in a single nested `create` —
   * already atomic on its own (Prisma issues it as one write), and doubly
   * so here because `runWithTenant` itself wraps the callback in a
   * `$transaction` (see PrismaService). `tenantId` is stamped on both the
   * sale row and every line item explicitly, same rationale as
   * `requireTenantId` above.
   */
  async create(input: CreateSaleRepoInput): Promise<SaleWithLineItems> {
    const tenantId = this.requireTenantId();
    const sale = await this.prisma.runWithTenant(async (tx) => {
      return tx.sale.create({
        data: {
          tenantId,
          patientId: input.patientId,
          currency: input.currency,
          total: input.total,
          paidAt: input.paidAt,
          paymentMethod: input.paymentMethod,
          notes: input.notes,
          createdById: input.createdById,
          lineItems: {
            create: input.lineItems.map((line) => ({
              tenantId,
              description: line.description,
              catalogItemId: line.catalogItemId,
              treatmentPlanItemId: line.treatmentPlanItemId,
              unitPrice: line.unitPrice,
              quantity: line.quantity,
              amount: line.amount,
            })),
          },
        },
        include: { lineItems: true },
      });
    });
    return mapToEntityWithLineItems(sale);
  }

  async findById(id: string): Promise<SaleWithLineItems | null> {
    const sale = await this.prisma.runWithTenant(async (tx) => {
      return tx.sale.findFirst({
        where: { id, deletedAt: null },
        include: { lineItems: true },
      });
    });
    return sale ? mapToEntityWithLineItems(sale) : null;
  }

  async listByRange(params: ListSalesByRangeParams): Promise<Sale[]> {
    const where: Prisma.SaleWhereInput = {
      deletedAt: null,
      ...(params.from || params.to
        ? {
            paidAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lt: params.to } : {}),
            },
          }
        : {}),
      ...(params.patientId ? { patientId: params.patientId } : {}),
    };

    return this.prisma.runWithTenant(async (tx) => {
      const sales = await tx.sale.findMany({
        where,
        orderBy: { paidAt: 'desc' },
      });
      return sales.map(mapToEntity);
    });
  }

  async softDelete(id: string): Promise<void> {
    await this.prisma.runWithTenant(async (tx) => {
      const existing = await tx.sale.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException('Sale not found');
      }

      await tx.sale.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    });
  }

  async listForTotals(
    params: ListSalesForTotalsParams,
  ): Promise<SaleTotalsRow[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const sales = await tx.sale.findMany({
        where: {
          deletedAt: null,
          paidAt: { gte: params.from, lt: params.to },
        },
        select: { id: true, currency: true, total: true, paidAt: true },
      });
      return sales.map((sale) => ({
        id: sale.id,
        currency: sale.currency,
        total: sale.total.toNumber(),
        paidAt: sale.paidAt,
      }));
    });
  }
}
