import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  ToothRecordStatus,
  TreatmentPlanItemStatus,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  AddTreatmentPlanItemRepoInput,
  DoneMirrorInput,
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
const ACCEPTANCE_SUMMARY = {
  select: { signerName: true, acceptedAt: true },
} satisfies Prisma.TreatmentPlanAcceptanceDefaultArgs;

type PrismaTreatmentPlanWithItems = Prisma.TreatmentPlanGetPayload<{
  include: { items: true; acceptance: typeof ACCEPTANCE_SUMMARY };
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
    discount: item.discount.toNumber(),
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
    acceptance: plan.acceptance
      ? {
          signerName: plan.acceptance.signerName,
          acceptedAt: plan.acceptance.acceptedAt,
        }
      : null,
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
        include: {
          items: { where: { deletedAt: null } },
          acceptance: ACCEPTANCE_SUMMARY,
        },
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
      await lockPlan(tx, input.planId);
      return tx.treatmentPlanItem.create({
        data: {
          tenantId,
          planId: input.planId,
          toothNumber: input.toothNumber,
          surfaces: input.surfaces ?? [],
          catalogItemId: input.catalogItemId,
          price: input.price,
          discount: input.discount ?? 0,
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
    mirror?: DoneMirrorInput,
  ): Promise<TreatmentPlanItem> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      await lockPlanOfItem(tx, id);
      // FOR UPDATE: un segundo PATCH concurrente sobre el mismo ítem espera
      // aquí al COMMIT del primero y lee el estado ya cambiado (DB-013).
      const [previous] = await tx.$queryRaw<
        { status: TreatmentPlanItemStatus }[]
      >`
        SELECT "status" FROM "treatment_plan_items"
         WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL
         FOR UPDATE`;
      if (!previous) {
        throw new NotFoundException('Treatment plan item not found');
      }

      const item = await tx.treatmentPlanItem.update({
        where: { id },
        data: patch,
      });

      const becameDone =
        previous.status !== TreatmentPlanItemStatus.DONE &&
        item.status === TreatmentPlanItemStatus.DONE;
      if (mirror && becameDone) {
        await mirrorIntoOdontogram(tx, tenantId, item, mirror);
      }
      return mapItemToEntity(item);
    });
  }

  async softDeleteItem(id: string): Promise<void> {
    await this.prisma.runWithTenant(async (tx) => {
      await lockPlanOfItem(tx, id);
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

/**
 * Orden de bloqueos plan → ítem (DX-012). La aceptación firmada bloquea el plan
 * FOR UPDATE y después sus ítems; toda escritura de ítems bloquea antes el plan
 * (FOR SHARE: varias ediciones a la vez no se estorban) y solo después el ítem.
 * Con el orden contrario (el ítem y luego, en el trigger
 * `treatment_plan_items_locked_when_accepted`, el plan) una edición y una firma
 * simultáneas se esperaban en cruz: deadlock (40P01).
 */
async function lockPlan(
  tx: Prisma.TransactionClient,
  planId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT "id" FROM "treatment_plans" WHERE "id" = ${planId}::uuid FOR SHARE`;
}

/** Igual que `lockPlan`, para el plan del ítem `itemId` (si existe). */
async function lockPlanOfItem(
  tx: Prisma.TransactionClient,
  itemId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT p."id" FROM "treatment_plans" p
      JOIN "treatment_plan_items" i ON i."planId" = p."id"
     WHERE i."id" = ${itemId}::uuid
       FOR SHARE OF p`;
}

/**
 * Registro COMPLETED del odontograma para un ítem que acaba de pasar a DONE,
 * dentro de la transacción del cambio de estado. Solo INSERTA (el odontograma
 * es append-only). Comprueba antes que el ítem no se haya espejado ya (un ítem
 * que vuelve a DONE tras revertirse no se duplica); el índice único parcial
 * `tooth_records_source_plan_item_key` es el respaldo de la base.
 */
async function mirrorIntoOdontogram(
  tx: Prisma.TransactionClient,
  tenantId: string,
  item: PrismaTreatmentPlanItem,
  mirror: DoneMirrorInput,
): Promise<void> {
  const already = await tx.toothRecord.findFirst({
    where: { sourcePlanItemId: item.id, deletedAt: null },
    select: { id: true },
  });
  if (already) return;

  await tx.toothRecord.create({
    data: {
      tenantId,
      patientId: mirror.patientId,
      toothNumber: item.toothNumber,
      surfaces: item.surfaces,
      kind: mirror.kind,
      catalogItemId: item.catalogItemId,
      status: ToothRecordStatus.COMPLETED,
      performedById: mirror.performedById,
      sourcePlanItemId: item.id,
      recordedAt: new Date(),
    },
  });
}
