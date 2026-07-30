import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  AddTreatmentPlanItemRepoInput,
  CreateTreatmentPlanRepoInput,
  TreatmentPlanRepository,
  UpdateTreatmentPlanItemRepoInput,
  UpdateTreatmentPlanRepoInput,
} from '../../domain/ports/treatment-plan-repository.port';
import {
  TreatmentPlan,
  TreatmentPlanWithItems,
} from '../../domain/entities/treatment-plan.entity';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';

type PrismaTreatmentPlan = Prisma.TreatmentPlanGetPayload<
  Record<string, never>
>;
type PrismaTreatmentPlanItem = Prisma.TreatmentPlanItemGetPayload<
  Record<string, never>
>;
type PrismaTreatmentPlanWithItems = Prisma.TreatmentPlanGetPayload<{
  include: { items: true };
}>;

function mapToEntity(plan: PrismaTreatmentPlan): TreatmentPlan {
  return {
    id: plan.id,
    tenantId: plan.tenantId,
    patientId: plan.patientId,
    status: plan.status,
    currency: plan.currency,
    notes: plan.notes,
    createdById: plan.createdById,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

// `price` is a Prisma `Decimal` at the DB layer; the API-facing entity
// exposes it as a plain `number` — same convention as
// `PrismaDentalCatalogRepository.mapToEntity` for `defaultPrice`.
function mapItemToEntity(item: PrismaTreatmentPlanItem): TreatmentPlanItem {
  return {
    id: item.id,
    tenantId: item.tenantId,
    planId: item.planId,
    toothNumber: item.toothNumber,
    surfaces: item.surfaces.map((surface) => surface),
    catalogItemId: item.catalogItemId,
    price: item.price.toNumber(),
    status: item.status,
    notes: item.notes,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function mapToEntityWithItems(
  plan: PrismaTreatmentPlanWithItems,
): TreatmentPlanWithItems {
  return {
    ...mapToEntity(plan),
    items: plan.items.map(mapItemToEntity),
  };
}

@Injectable()
export class PrismaTreatmentPlanRepository implements TreatmentPlanRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `tenantId` is NOT NULL at the DB level with no column default that
   * autofills from the RLS GUC, so — unlike a plain SELECT/UPDATE/DELETE,
   * which RLS filters transparently — an INSERT still needs the app to
   * supply it explicitly. We never take it from the input (never from the
   * client); we read it from the same request-scoped context that
   * `runWithTenant(fn)` uses to set `app.current_tenant`, so the value
   * written always matches the GUC the WITH CHECK policy validates against
   * (same convention as PrismaAppointmentRepository / PrismaDentalCatalogRepository).
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async createPlan(
    input: CreateTreatmentPlanRepoInput,
  ): Promise<TreatmentPlan> {
    const tenantId = this.requireTenantId();
    const plan = await this.prisma.runWithTenant(async (tx) => {
      return tx.treatmentPlan.create({
        data: {
          tenantId,
          patientId: input.patientId,
          currency: input.currency,
          notes: input.notes,
          createdById: input.createdById,
        },
      });
    });
    return mapToEntity(plan);
  }

  async findPlanById(id: string): Promise<TreatmentPlanWithItems | null> {
    const plan = await this.prisma.runWithTenant(async (tx) => {
      return tx.treatmentPlan.findFirst({
        where: { id, deletedAt: null },
        include: { items: { where: { deletedAt: null } } },
      });
    });
    return plan ? mapToEntityWithItems(plan) : null;
  }

  async listPlansByPatient(patientId: string): Promise<TreatmentPlan[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const plans = await tx.treatmentPlan.findMany({
        where: { patientId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return plans.map(mapToEntity);
    });
  }

  async updatePlan(
    id: string,
    patch: UpdateTreatmentPlanRepoInput,
  ): Promise<TreatmentPlan> {
    return this.prisma.runWithTenant(async (tx) => {
      const existing = await tx.treatmentPlan.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException('Treatment plan not found');
      }

      const plan = await tx.treatmentPlan.update({
        where: { id },
        data: patch,
      });
      return mapToEntity(plan);
    });
  }

  async addItem(
    input: AddTreatmentPlanItemRepoInput,
  ): Promise<TreatmentPlanItem> {
    const tenantId = this.requireTenantId();
    const item = await this.prisma.runWithTenant(async (tx) => {
      return tx.treatmentPlanItem.create({
        data: {
          tenantId,
          planId: input.planId,
          toothNumber: input.toothNumber,
          surfaces: input.surfaces ?? [],
          catalogItemId: input.catalogItemId,
          price: input.price,
          notes: input.notes,
        },
      });
    });
    return mapItemToEntity(item);
  }

  async findItemById(id: string): Promise<TreatmentPlanItem | null> {
    const item = await this.prisma.runWithTenant(async (tx) => {
      return tx.treatmentPlanItem.findFirst({
        where: { id, deletedAt: null },
      });
    });
    return item ? mapItemToEntity(item) : null;
  }

  async updateItem(
    id: string,
    patch: UpdateTreatmentPlanItemRepoInput,
  ): Promise<TreatmentPlanItem> {
    return this.prisma.runWithTenant(async (tx) => {
      const existing = await tx.treatmentPlanItem.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException('Treatment plan item not found');
      }

      const item = await tx.treatmentPlanItem.update({
        where: { id },
        data: patch,
      });
      return mapItemToEntity(item);
    });
  }

  async softDeleteItem(id: string): Promise<void> {
    await this.prisma.runWithTenant(async (tx) => {
      const existing = await tx.treatmentPlanItem.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException('Treatment plan item not found');
      }

      await tx.treatmentPlanItem.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    });
  }
}
