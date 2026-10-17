import { Injectable } from '@nestjs/common';
import { Prisma, TreatmentPlanItemStatus } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  AlternativeSource,
  NewAlternative,
  PendingFollowUpQuery,
  PendingFollowUpRow,
  PlanOptionsRepository,
} from '../../domain/ports/plan-options-repository.port';
import type { TreatmentPlan } from '../../domain/entities/treatment-plan.entity';
import {
  ACCEPTANCE_SUMMARY,
  mapToEntity,
  mapToEntityWithItems,
} from './prisma-treatment-plan.repository';
import { lockPlanGroup } from './plan-option-group';

interface FollowUpSqlRow {
  planId: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string | null;
  patientCountryCode: string | null;
  optionGroupId: string | null;
  optionLabel: string | null;
  presentedAt: Date;
  presentedLocationId: string;
  currency: string;
  total: Prisma.Decimal;
  itemCount: number;
}

/**
 * Alternativas de un plan y presupuestos por seguir (DX-040). Todo bajo
 * `runWithTenant` (RLS de treatment_plans, treatment_plan_items, patients y
 * appointments): nada de otra clínica existe aquí. El grupo, además, lo
 * garantiza la base con la FK compuesta (tenantId, optionGroupId, patientId).
 */
@Injectable()
export class PrismaPlanOptionsRepository implements PlanOptionsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  createAlternative(
    sourcePlanId: string,
    decide: (source: AlternativeSource) => NewAlternative,
  ): Promise<TreatmentPlan | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // El grupo bloqueado: una aceptación simultánea de otra opción espera a
      // que exista la alternativa (y la rechaza), o la alternativa espera a la
      // aceptación (y ve el grupo cerrado: 409).
      const locked = await lockPlanGroup(tx, sourcePlanId);
      if (!locked) return null;
      const source = await tx.treatmentPlan.findFirst({
        where: { id: sourcePlanId, deletedAt: null },
        include: {
          items: {
            where: { deletedAt: null },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
          acceptance: ACCEPTANCE_SUMMARY,
        },
      });
      if (!source) return null;
      const siblings = locked.optionGroupId
        ? await tx.treatmentPlan.findMany({
            where: {
              optionGroupId: locked.optionGroupId,
              id: { not: sourcePlanId },
              deletedAt: null,
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })
        : [];

      const decision = decide({
        plan: mapToEntityWithItems(source),
        siblings: siblings.map(mapToEntity),
      });

      // Un plan suelto abre el grupo: el grupo es su propio id.
      const groupId = source.optionGroupId ?? source.id;
      await tx.treatmentPlan.update({
        where: { id: source.id },
        data: { optionGroupId: groupId, optionLabel: decision.sourceLabel },
      });
      const created = await tx.treatmentPlan.create({
        data: {
          tenantId,
          patientId: source.patientId,
          currency: source.currency,
          notes: source.notes,
          createdById: decision.createdById,
          optionGroupId: groupId,
          optionLabel: decision.label,
        },
      });
      if (source.items.length > 0) {
        await tx.treatmentPlanItem.createMany({
          data: source.items.map((item) => ({
            tenantId,
            planId: created.id,
            toothNumber: item.toothNumber,
            surfaces: item.surfaces,
            catalogItemId: item.catalogItemId,
            price: item.price,
            discount: item.discount,
            // DX-204: la alternativa copia el descuento tal como se dio.
            discountReason: item.discountReason,
            discountReasonNote: item.discountReasonNote,
            discountById: item.discountById,
            discountAt: item.discountAt,
            discountLocationId: item.discountLocationId,
            notes: item.notes,
            status: TreatmentPlanItemStatus.PROPOSED,
          })),
        });
      }
      return mapToEntity(created);
    });
  }

  listPendingFollowUp(
    query: PendingFollowUpQuery,
  ): Promise<{ rows: PendingFollowUpRow[]; total: number }> {
    const locationId = this.tenantContext.getLocationId();
    // Sin sede en el request = vista consolidada de toda la clínica.
    const locationFilter = locationId
      ? Prisma.sql`AND p."presentedLocationId" = ${locationId}::uuid`
      : Prisma.empty;
    // Sin cita FUTURA y viva (agendada o confirmada) del paciente, en
    // cualquier sede: si ya vuelve, no hace falta llamarlo.
    const where = Prisma.sql`
      p."status" = 'PRESENTED'
      AND p."deletedAt" IS NULL
      AND p."presentedAt" <= ${query.presentedBefore}
      ${locationFilter}
      AND pa."deletedAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "appointments" a
         WHERE a."patientId" = p."patientId"
           AND a."deletedAt" IS NULL
           AND a."status" IN ('SCHEDULED', 'CONFIRMED')
           AND a."start" > ${query.now}
      )`;
    const offset = (query.page - 1) * query.pageSize;

    return this.prisma.runWithTenant(
      async (tx) => {
        const [{ total }] = await tx.$queryRaw<{ total: number }[]>`
          SELECT count(*)::int AS "total"
            FROM "treatment_plans" p
            JOIN "patients" pa ON pa."id" = p."patientId"
           WHERE ${where}`;
        const rows = await tx.$queryRaw<FollowUpSqlRow[]>`
          SELECT p."id" AS "planId",
                 p."patientId",
                 pa."firstName" AS "patientFirstName",
                 pa."lastName" AS "patientLastName",
                 pa."phone" AS "patientPhone",
                 pa."countryCode" AS "patientCountryCode",
                 p."optionGroupId",
                 p."optionLabel",
                 p."presentedAt",
                 p."presentedLocationId",
                 p."currency",
                 coalesce(sum(i."price" - i."discount"), 0) AS "total",
                 count(i."id")::int AS "itemCount"
            FROM "treatment_plans" p
            JOIN "patients" pa ON pa."id" = p."patientId"
            LEFT JOIN "treatment_plan_items" i
              ON i."planId" = p."id" AND i."deletedAt" IS NULL
           WHERE ${where}
           GROUP BY p."id", pa."id"
           ORDER BY p."presentedAt" ASC, p."id" ASC
           LIMIT ${query.pageSize} OFFSET ${offset}`;
        return {
          total,
          rows: rows.map((row) => ({ ...row, total: row.total.toNumber() })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
