import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { loadLocationTimeZones } from '../../../shared/locations/location-time-zone';
import { DEFAULT_BUSINESS_HOURS_TIMEZONE } from '../../../shared/locations/default-business-hours';
import {
  ADMIN_FEES_PLAN_LABEL,
  FEE_CATALOG_CODE,
  FEE_CATALOG_LABEL,
  FEE_TOOTH_NUMBER,
} from '../domain/cancellation-fee';
import type {
  CancellationFeeContext,
  CancellationFeeRecord,
  CancellationFeeRepository,
  ChargeFeeInput,
  FeeWriteOutcome,
  WaiveFeeInput,
} from '../domain/ports/cancellation-fee-repository.port';

const FEE_SELECT = {
  id: true,
  status: true,
  amount: true,
  currency: true,
  planItemId: true,
  waiveReason: true,
  policyVersionId: true,
  createdAt: true,
  planItem: { select: { planId: true } },
  createdBy: { select: { fullName: true } },
} as const satisfies Prisma.CancellationFeeSelect;

type SelectedFee = Prisma.CancellationFeeGetPayload<{
  select: typeof FEE_SELECT;
}>;

function toRecord(fee: SelectedFee): CancellationFeeRecord {
  return {
    id: fee.id,
    status: fee.status,
    amount: fee.amount === null ? null : fee.amount.toNumber(),
    currency: fee.currency,
    planId: fee.planItem?.planId ?? null,
    planItemId: fee.planItemId,
    waiveReason: fee.waiveReason,
    policyVersionId: fee.policyVersionId,
    createdAt: fee.createdAt,
    createdByName: fee.createdBy.fullName ?? null,
  };
}

/** Día civil `YYYY-MM-DD` de una columna DATE (Prisma la trae a medianoche UTC). */
const civil = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Fuerza el ROLLBACK cuando la cita cambió bajo nuestros pies. */
class StaleAppointmentError extends Error {}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class PrismaCancellationFeeRepository implements CancellationFeeRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async loadContext(
    appointmentId: string,
  ): Promise<CancellationFeeContext | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(
      async (tx) => {
        const appointment = await tx.appointment.findFirst({
          where: { id: appointmentId, deletedAt: null },
          select: {
            id: true,
            patientId: true,
            locationId: true,
            start: true,
            status: true,
            lateCancellation: true,
            policyVersionId: true,
            location: { select: { country: true } },
            policyVersion: {
              select: {
                id: true,
                version: true,
                noticeHours: true,
                suggestedFee: true,
                currency: true,
              },
            },
            cancellationFee: { select: FEE_SELECT },
          },
        });
        if (!appointment) return null;
        const [current, zones, coverages] = await Promise.all([
          tx.cancellationPolicyVersion.findFirst({
            where: { locationId: appointment.locationId },
            orderBy: { version: 'desc' },
            select: { receptionCanCharge: true },
          }),
          loadLocationTimeZones(tx, tenantId, [appointment.locationId]),
          tx.patientCoverage.findMany({
            where: { patientId: appointment.patientId, deletedAt: null },
            select: {
              validFrom: true,
              validTo: true,
              payer: { select: { type: true } },
            },
          }),
        ]);
        const version = appointment.policyVersion;
        return {
          appointment: {
            id: appointment.id,
            patientId: appointment.patientId,
            locationId: appointment.locationId,
            start: appointment.start,
            status: appointment.status,
            lateCancellation: appointment.lateCancellation,
            policyVersionId: appointment.policyVersionId,
          },
          communicated: version
            ? {
                id: version.id,
                version: version.version,
                noticeHours: version.noticeHours,
                suggestedFee:
                  version.suggestedFee === null
                    ? null
                    : version.suggestedFee.toNumber(),
                currency: version.currency,
              }
            : null,
          receptionCanCharge: current?.receptionCanCharge ?? false,
          locationCountry: appointment.location.country,
          locationTimeZone:
            zones.get(appointment.locationId) ??
            DEFAULT_BUSINESS_HOURS_TIMEZONE,
          coverages: coverages.map((c) => ({
            payerType: c.payer.type,
            validFrom: civil(c.validFrom),
            validTo: civil(c.validTo),
          })),
          fee: appointment.cancellationFee
            ? toRecord(appointment.cancellationFee)
            : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * Bloquea la cita y comprueba que sigue como al decidir. `null` = cambió
   * (o se retiró): no se escribe nada.
   */
  private async lockAppointment(
    tx: Prisma.TransactionClient,
    appointmentId: string,
  ) {
    await tx.$queryRaw`SELECT "id" FROM "appointments"
      WHERE "id" = ${appointmentId}::uuid FOR UPDATE`;
    return tx.appointment.findFirst({
      where: { id: appointmentId, deletedAt: null },
      select: {
        status: true,
        policyVersionId: true,
        patientId: true,
        locationId: true,
        lateCancellation: true,
        cancellationFee: { select: { id: true } },
      },
    });
  }

  /** El procedimiento «Cargo por inasistencia…» del catálogo de la clínica. */
  private async feeCatalogItemId(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string> {
    // Inactivo: no sale en los selectores del plan clínico. ON CONFLICT sobre
    // el único parcial (tenantId, code) de los vivos: dos cargos simultáneos
    // de la misma clínica lo crean una sola vez.
    await tx.$executeRaw`
      INSERT INTO "dental_catalog_items"
        ("id", "tenantId", "code", "category", "kind", "labelEs", "color",
         "allowDiscount", "active", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${FEE_CATALOG_CODE},
              'Administrativo', 'PROCEDURE', ${FEE_CATALOG_LABEL}, '#57534E',
              false, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("tenantId", "code") WHERE "deletedAt" IS NULL DO NOTHING`;
    const item = await tx.dentalCatalogItem.findFirstOrThrow({
      where: { code: FEE_CATALOG_CODE, deletedAt: null },
      select: { id: true },
    });
    return item.id;
  }

  /**
   * El plan ACCEPTED «Cargos administrativos» del paciente en esa moneda: el
   * que ya tiene cargos de este flujo, o uno nuevo. El paciente queda
   * bloqueado (FOR UPDATE) hasta el COMMIT, así que dos cargos simultáneos
   * del mismo paciente (de citas distintas) no crean dos planes.
   */
  private async adminFeesPlanId(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      patientId: string;
      locationId: string;
      currency: string;
      createdById: string;
      now: Date;
    },
  ): Promise<string> {
    await tx.$queryRaw`SELECT "id" FROM "patients"
      WHERE "id" = ${input.patientId}::uuid FOR UPDATE`;
    const [existing] = await tx.$queryRaw<{ id: string }[]>`
      SELECT p."id"
        FROM "treatment_plans" p
       WHERE p."patientId" = ${input.patientId}::uuid
         AND p."currency" = ${input.currency}
         AND p."status" = 'ACCEPTED'
         AND p."deletedAt" IS NULL
         AND p."optionLabel" = ${ADMIN_FEES_PLAN_LABEL}
         AND EXISTS (
           SELECT 1
             FROM "cancellation_fees" f
             JOIN "treatment_plan_items" i ON i."id" = f."planItemId"
            WHERE f."patientId" = ${input.patientId}::uuid
              AND i."planId" = p."id")
       ORDER BY p."createdAt" DESC
       LIMIT 1`;
    if (existing) return existing.id;
    const plan = await tx.treatmentPlan.create({
      data: {
        tenantId: input.tenantId,
        patientId: input.patientId,
        status: 'ACCEPTED',
        currency: input.currency,
        acceptedAt: input.now,
        acceptedLocationId: input.locationId,
        optionLabel: ADMIN_FEES_PLAN_LABEL,
        notes:
          'Cargos por inasistencia o cancelación tardía según la política de cancelación de la sede.',
        createdById: input.createdById,
      },
      select: { id: true },
    });
    return plan.id;
  }

  async charge(input: ChargeFeeInput): Promise<FeeWriteOutcome> {
    const tenantId = this.requireTenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const appointment = await this.lockAppointment(tx, input.appointmentId);
        if (
          !appointment ||
          appointment.status !== input.expectedStatus ||
          appointment.policyVersionId !== input.expectedPolicyVersionId
        )
          throw new StaleAppointmentError();
        if (appointment.cancellationFee) return { outcome: 'EXISTS' };

        const now = new Date();
        const catalogItemId = await this.feeCatalogItemId(tx, tenantId);
        const planId = await this.adminFeesPlanId(tx, {
          tenantId,
          patientId: appointment.patientId,
          locationId: appointment.locationId,
          currency: input.currency,
          createdById: input.createdById,
          now,
        });
        const item = await tx.treatmentPlanItem.create({
          data: {
            tenantId,
            planId,
            toothNumber: FEE_TOOTH_NUMBER,
            surfaces: [],
            catalogItemId,
            price: input.amount,
            status: 'DONE',
            completedAt: now,
            performedLocationId: appointment.locationId,
            createdById: input.createdById,
            notes:
              appointment.status === 'NO_SHOW'
                ? 'Inasistencia a la cita'
                : 'Cancelación tardía de la cita',
          },
          select: { id: true },
        });
        const fee = await tx.cancellationFee.create({
          data: {
            tenantId,
            appointmentId: input.appointmentId,
            patientId: appointment.patientId,
            locationId: appointment.locationId,
            policyVersionId: input.expectedPolicyVersionId,
            status: 'CHARGED',
            amount: input.amount,
            currency: input.currency,
            planItemId: item.id,
            createdById: input.createdById,
          },
          select: FEE_SELECT,
        });
        return { outcome: 'OK', fee: toRecord(fee) };
      });
    } catch (error) {
      if (error instanceof StaleAppointmentError) return { outcome: 'STALE' };
      // Respaldo del candado: el índice único por cita.
      if (isUniqueViolation(error)) return { outcome: 'EXISTS' };
      throw error;
    }
  }

  async waive(input: WaiveFeeInput): Promise<FeeWriteOutcome> {
    const tenantId = this.requireTenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const appointment = await this.lockAppointment(tx, input.appointmentId);
        if (!appointment || appointment.status !== input.expectedStatus)
          throw new StaleAppointmentError();
        if (appointment.cancellationFee) return { outcome: 'EXISTS' };
        const fee = await tx.cancellationFee.create({
          data: {
            tenantId,
            appointmentId: input.appointmentId,
            patientId: appointment.patientId,
            locationId: appointment.locationId,
            policyVersionId: appointment.policyVersionId,
            status: 'WAIVED',
            waiveReason: input.reason,
            createdById: input.createdById,
          },
          select: FEE_SELECT,
        });
        return { outcome: 'OK', fee: toRecord(fee) };
      });
    } catch (error) {
      if (error instanceof StaleAppointmentError) return { outcome: 'STALE' };
      if (isUniqueViolation(error)) return { outcome: 'EXISTS' };
      throw error;
    }
  }
}
