import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  ToothRecordStatus,
  TreatmentPlanItemStatus,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  DecideBulkDiscount,
  DecideItemChange,
  DecideNewItem,
  DecidePlanChange,
  DiscountStamp,
  DoneMirrorInput,
  CreateTreatmentPlanRepoInput,
  TreatmentPlanRepository,
} from '../../domain/ports/treatment-plan-repository.port';
import {
  acceptPlanInTx,
  cancelActivePaymentPlans,
  lockPlanGroup,
} from './plan-option-group';
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
export const ACCEPTANCE_SUMMARY = {
  select: { signerName: true, acceptedAt: true },
} satisfies Prisma.TreatmentPlanAcceptanceDefaultArgs;

type PrismaTreatmentPlanWithItems = Prisma.TreatmentPlanGetPayload<{
  include: { items: true; acceptance: typeof ACCEPTANCE_SUMMARY };
}>;

export function mapToEntity(plan: PrismaTreatmentPlan): TreatmentPlan {
  return {
    visitIntervals: plan.visitIntervals as Record<string, number>,
    acceptedAt: plan.acceptedAt,
    acceptedLocationId: plan.acceptedLocationId,
    id: plan.id,
    tenantId: plan.tenantId,
    patientId: plan.patientId,
    status: plan.status,
    currency: plan.currency,
    notes: plan.notes,
    createdById: plan.createdById,
    optionGroupId: plan.optionGroupId,
    optionLabel: plan.optionLabel,
    presentedAt: plan.presentedAt,
    presentedLocationId: plan.presentedLocationId,
    rejectedAt: plan.rejectedAt,
    rejectionReason: plan.rejectionReason,
    rejectionNote: plan.rejectionNote,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

// `price` is a Prisma `Decimal` at the DB layer; the API-facing entity
// exposes it as a plain `number` — same convention as
// `PrismaDentalCatalogRepository.mapToEntity` for `defaultPrice`.
function mapItemToEntity(item: PrismaTreatmentPlanItem): TreatmentPlanItem {
  return {
    visit: item.visit,
    visitLabel: item.visitLabel,
    id: item.id,
    tenantId: item.tenantId,
    planId: item.planId,
    toothNumber: item.toothNumber,
    surfaces: item.surfaces.map((surface) => surface),
    catalogItemId: item.catalogItemId,
    catalogPrice: item.catalogPrice?.toNumber() ?? null,
    basePrice: item.basePrice?.toNumber() ?? null,
    priceSource: item.priceSource,
    agreementId: item.agreementId,
    agreementName: item.agreementName,
    pricingLocationId: item.pricingLocationId,
    price: item.price.toNumber(),
    discount: item.discount.toNumber(),
    discountReason: item.discountReason,
    discountReasonNote: item.discountReasonNote,
    discountById: item.discountById,
    discountAt: item.discountAt,
    discountLocationId: item.discountLocationId,
    status: item.status,
    notes: item.notes,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * Columnas de autor, hora y sede del descuento (DX-204). `undefined` = no se
 * tocan; `null` = el ítem se queda sin descuento.
 */
async function discountStampData(
  tx: Prisma.TransactionClient,
  stamp: DiscountStamp | null | undefined,
  tenantContext: TenantContextService,
): Promise<{
  discountById?: string | null;
  discountAt?: Date | null;
  discountLocationId?: string | null;
}> {
  if (stamp === undefined) return {};
  if (stamp === null) {
    return { discountById: null, discountAt: null, discountLocationId: null };
  }
  return {
    discountById: stamp.byId,
    discountAt: stamp.at,
    // DX-089: la sede del request o la de escritura de la sesión.
    discountLocationId: await tenantContext.writeLocationId(tx),
  };
}

export function mapToEntityWithItems(
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
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return plans.map(mapToEntity);
    });
  }

  async updatePlan(
    id: string,
    decide: DecidePlanChange,
  ): Promise<TreatmentPlan> {
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await lockPlanGroup(tx, id);
      const current = locked
        ? await tx.treatmentPlan.findFirst({
            where: { id, deletedAt: null },
            include: {
              items: { where: { deletedAt: null } },
              acceptance: ACCEPTANCE_SUMMARY,
            },
          })
        : null;
      if (!locked || !current) {
        throw new NotFoundException('Plan de tratamiento no encontrado');
      }

      const [livePayment, activePaymentPlan] = await Promise.all([
        tx.payment.findFirst({
          where: { treatmentPlanId: id, deletedAt: null, voidedAt: null },
          select: { id: true },
        }),
        tx.paymentPlan.findFirst({
          where: { treatmentPlanId: id, status: 'ACTIVE', deletedAt: null },
          select: { id: true },
        }),
      ]);
      const change = decide(mapToEntityWithItems(current), {
        hasLivePayments: livePayment !== null,
        hasActivePaymentPlan: activePaymentPlan !== null,
      });
      const data: Prisma.TreatmentPlanUncheckedUpdateInput = {
        status: change.status,
        currency: change.currency,
        notes: change.notes,
        optionLabel: change.optionLabel,
      };
      if (change.presentation) {
        // La sede del request o, en la vista consolidada, la de escritura de
        // la sesión (la principal, o la primera permitida — DX-089): la lista
        // de presupuestos por seguir filtra por ella.
        data.presentedAt = change.presentation.at;
        data.presentedLocationId = await this.tenantContext.writeLocationId(tx);
      }
      if (change.rejection) {
        data.rejectedAt = change.rejection.at;
        data.rejectionReason = change.rejection.reason;
        data.rejectionNote = change.rejection.note;
      }
      if (change.acceptedAt) {
        // La misma aceptación que la firmada (DX-109): hermanas, estado e
        // ítems PROPOSED → ACCEPTED.
        await acceptPlanInTx(
          tx,
          locked,
          change.acceptedAt,
          change.acceptedById ?? null,
          await this.tenantContext.writeLocationId(tx),
        );
      }
      if (change.cancellation) {
        // Un plan cancelado o rechazado no se cobra: su plan de cuotas ACTIVO
        // se cancela con él, en esta transacción (DX-109), con hora, autor y
        // motivo.
        await cancelActivePaymentPlans(tx, [id], change.cancellation);
      }

      const plan = await tx.treatmentPlan.update({ where: { id }, data });
      return mapToEntity(plan);
    });
  }

  async addItem(
    planId: string,
    decide: DecideNewItem,
  ): Promise<TreatmentPlanItem> {
    const tenantId = this.requireTenantId();
    const item = await this.prisma.runWithTenant(async (tx) => {
      const plan = await lockedPlan(tx, planId);
      if (!plan) {
        throw new NotFoundException('Treatment plan not found');
      }
      const input = decide(plan);
      return tx.treatmentPlanItem.create({
        data: {
          tenantId,
          planId,
          toothNumber: input.toothNumber,
          surfaces: input.surfaces ?? [],
          catalogItemId: input.catalogItemId,
          catalogPrice: input.catalogPrice,
          // DX-105: foto del precio, resuelta por el caso de uso.
          basePrice: input.pricing.basePrice,
          priceSource: input.pricing.priceSource,
          agreementId: input.pricing.agreementId,
          agreementName: input.pricing.agreementName,
          pricingLocationId: input.pricing.pricingLocationId,
          price: input.price,
          discount: input.discount ?? 0,
          notes: input.notes,
          discountReason: input.discountReason ?? null,
          discountReasonNote: input.discountReasonNote ?? null,
          ...(await discountStampData(
            tx,
            input.discountStamp ?? undefined,
            this.tenantContext,
          )),
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
    decide: DecideItemChange,
  ): Promise<TreatmentPlanItem> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const planId = await lockPlanOfItem(tx, id);
      // FOR UPDATE: un segundo PATCH concurrente sobre el mismo ítem espera
      // aquí al COMMIT del primero y lee el estado ya cambiado (DB-013).
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "treatment_plan_items"
         WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL
         FOR UPDATE`;
      // BE-036: plan e ítem releídos con sus filas bloqueadas; lo que decide
      // `decide` es lo que hay al escribir (una aceptación que entró antes
      // ya está aquí; una posterior espera a este COMMIT).
      const plan = planId ? await lockedPlan(tx, planId) : null;
      const previous = locked
        ? await tx.treatmentPlanItem.findUniqueOrThrow({ where: { id } })
        : null;
      if (!plan || !previous) {
        throw new NotFoundException('Treatment plan item not found');
      }

      const { patch, mirror } = decide({
        plan,
        item: mapItemToEntity(previous),
      });
      const { discountStamp, ...fields } = patch;
      const item = await tx.treatmentPlanItem.update({
        where: { id },
        data: {
          ...fields,
          ...(await discountStampData(tx, discountStamp, this.tenantContext)),
        },
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

  async applyBulkDiscount(
    planId: string,
    itemIds: string[],
    decide: DecideBulkDiscount,
  ): Promise<TreatmentPlanItem[]> {
    const ids = [...new Set(itemIds)];
    return this.prisma.runWithTenant(async (tx) => {
      const plan = await lockedPlan(tx, planId);
      if (!plan) {
        throw new NotFoundException('Plan de tratamiento no encontrado');
      }
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "treatment_plan_items"
         WHERE "id" = ANY(${ids}::uuid[])
           AND "planId" = ${planId}::uuid
           AND "deletedAt" IS NULL
         ORDER BY "id"
           FOR UPDATE`;
      if (locked.length !== ids.length) {
        throw new NotFoundException(
          'Algún ítem no existe o no es de este plan de tratamiento.',
        );
      }
      const current = await tx.treatmentPlanItem.findMany({
        where: { id: { in: ids } },
        orderBy: { id: 'asc' },
      });
      const changes = decide({ plan, items: current.map(mapItemToEntity) });
      const updated: TreatmentPlanItem[] = [];
      for (const change of changes) {
        const item = await tx.treatmentPlanItem.update({
          where: { id: change.itemId },
          data: {
            discount: change.discount,
            discountReason: change.discountReason,
            discountReasonNote: change.discountReasonNote,
            ...(await discountStampData(
              tx,
              change.discountStamp,
              this.tenantContext,
            )),
          },
        });
        updated.push(mapItemToEntity(item));
      }
      return updated;
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

/**
 * Igual que `lockPlan`, para el plan del ítem `itemId`. Devuelve su id (o
 * undefined si el ítem no existe).
 */
async function lockPlanOfItem(
  tx: Prisma.TransactionClient,
  itemId: string,
): Promise<string | undefined> {
  const [plan] = await tx.$queryRaw<{ id: string }[]>`
    SELECT p."id" FROM "treatment_plans" p
      JOIN "treatment_plan_items" i ON i."planId" = p."id"
     WHERE i."id" = ${itemId}::uuid
       FOR SHARE OF p`;
  return plan?.id;
}

/**
 * BE-036: bloquea el plan (`lockPlan`) y lo RELEE en la misma transacción,
 * con sus ítems vivos y su aceptación firmada: en READ COMMITTED la lectura
 * posterior al bloqueo ve lo que confirmó quien lo tenía (p. ej. una
 * aceptación). null si no existe, está retirado o es de otra clínica.
 */
async function lockedPlan(
  tx: Prisma.TransactionClient,
  planId: string,
): Promise<TreatmentPlanWithItems | null> {
  await lockPlan(tx, planId);
  const plan = await tx.treatmentPlan.findFirst({
    where: { id: planId, deletedAt: null },
    include: {
      items: { where: { deletedAt: null } },
      acceptance: ACCEPTANCE_SUMMARY,
    },
  });
  return plan ? mapToEntityWithItems(plan) : null;
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
