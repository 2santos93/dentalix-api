import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  ADMIN_FEES_PLAN_LABEL,
  FEE_CATALOG_CODE,
  FEE_CATALOG_LABEL,
  FEE_TOOTH_NUMBER,
  voidPaymentsCheck,
  type FeeVoidPaymentsCheck,
} from '../domain/cancellation-fee';
import type {
  CancellationFeeContext,
  CancellationFeeRecord,
  CancellationFeeRepository,
  ChargeFeeInput,
  FeeVoidOutcome,
  FeeWriteOutcome,
  VoidFeeInput,
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
  voidedAt: true,
  voidReason: true,
  planItem: {
    select: { planId: true, deletedAt: true, price: true, discount: true },
  },
  createdBy: { select: { fullName: true } },
  voidedBy: { select: { fullName: true } },
} as const satisfies Prisma.CancellationFeeSelect;

type SelectedFee = Prisma.CancellationFeeGetPayload<{
  select: typeof FEE_SELECT;
}>;

function toRecord(fee: SelectedFee): CancellationFeeRecord {
  const item = fee.planItem;
  // SEC-050: lo que cobra hoy el ítem vivo, para avisar si no cuadra.
  const itemAmount =
    item && item.deletedAt === null ? item.price.minus(item.discount) : null;
  return {
    id: fee.id,
    status: fee.status,
    amount: fee.amount === null ? null : fee.amount.toNumber(),
    currency: fee.currency,
    planId: fee.planItem?.planId ?? null,
    planItemId: fee.planItemId,
    planItemRemoved: fee.planItem?.deletedAt != null,
    waiveReason: fee.waiveReason,
    policyVersionId: fee.policyVersionId,
    createdAt: fee.createdAt,
    createdByName: fee.createdBy.fullName ?? null,
    itemAmount: itemAmount === null ? null : itemAmount.toNumber(),
    itemMismatch:
      itemAmount !== null &&
      fee.amount !== null &&
      !itemAmount.equals(fee.amount),
    voidedAt: fee.voidedAt,
    voidedByName: fee.voidedBy?.fullName ?? null,
    voidReason: fee.voidReason,
  };
}

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
          where: { id: appointmentId, tenantId, deletedAt: null },
          select: {
            id: true,
            patientId: true,
            locationId: true,
            start: true,
            status: true,
            lateCancellation: true,
            policyVersionId: true,
            location: {
              select: { id: true, locale: true, hourCycle: true },
            },
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
        const current = await tx.cancellationPolicyVersion.findFirst({
          where: { locationId: appointment.locationId },
          orderBy: { version: 'desc' },
          select: { receptionCanCharge: true },
        });
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
          locationLocale: appointment.location.locale,
          locationHourCycle: appointment.location.hourCycle,
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

  async voidFee(input: VoidFeeInput): Promise<FeeVoidOutcome> {
    const tenantId = this.requireTenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const appointment = await this.lockAppointment(tx, input.appointmentId);
        if (!appointment) throw new StaleAppointmentError();
        // La fila del cargo bloqueada: dos anulaciones a la vez se ponen en
        // fila y la segunda ve la primera.
        const [fee] = await tx.$queryRaw<
          {
            id: string;
            status: string;
            voidedAt: Date | null;
            planItemId: string | null;
          }[]
        >`SELECT "id", "status"::text AS "status", "voidedAt", "planItemId"
            FROM "cancellation_fees"
           WHERE "tenantId" = ${tenantId}::uuid
             AND "appointmentId" = ${input.appointmentId}::uuid
           FOR UPDATE`;
        if (!fee || fee.status !== 'CHARGED') return { outcome: 'NOT_CHARGED' };
        if (fee.voidedAt) return { outcome: 'ALREADY_VOIDED' };

        const item = fee.planItemId
          ? await tx.treatmentPlanItem.findFirst({
              where: { id: fee.planItemId, tenantId, deletedAt: null },
              select: { id: true, planId: true },
            })
          : null;
        if (item) {
          const check = await this.paymentsCheck(tx, tenantId, item);
          if (check === 'PAID') return { outcome: 'PAID' };
          if (check === 'UNCONVERTED') return { outcome: 'UNCONVERTED' };
        }

        // Primero la anulación (autor y motivo) y después el ítem: el trigger
        // `treatment_plan_items_cancellation_fee_locked` solo deja retirar el
        // ítem de un cargo que ya no está vigente en esta transacción.
        await tx.cancellationFee.update({
          where: { id: fee.id },
          data: {
            voidedAt: new Date(),
            voidedById: input.voidedById,
            voidReason: input.reason,
          },
          select: { id: true },
        });
        if (item) {
          await tx.treatmentPlanItem.update({
            where: { id: item.id },
            data: { deletedAt: new Date() },
            select: { id: true },
          });
        }
        const voided = await tx.cancellationFee.findUniqueOrThrow({
          where: { id: fee.id },
          select: FEE_SELECT,
        });
        return { outcome: 'OK', fee: toRecord(voided) };
      });
    } catch (error) {
      if (error instanceof StaleAppointmentError) return { outcome: 'STALE' };
      throw error;
    }
  }

  /**
   * ¿Se puede retirar el ítem sin dejar un saldo a favor escondido? Compara
   * en la MONEDA DEL PLAN (DX-382, BE-046): cada abono vivo con su base de
   * imputación (DX-051, convertida con la tasa que congeló al cobrarse,
   * DX-375) frente a lo que queda por cobrar sin este ítem; un abono sin base
   * («sin tasa») no deja decidir. Si ya se cobró, primero se anula el abono.
   *
   * Bloqueos en el orden R6 de DX-051 (plan → bases ORDER BY "paymentId" →
   * ítems), y las sumas en sentencias POSTERIORES. El plan va FOR UPDATE, no
   * FOR SHARE: un abono nuevo (que lo bloquea FOR SHARE), la anulación de un
   * abono, la reasignación y el reparto (que también lo toman FOR SHARE
   * primero) esperan a la anulación y la ven. Una base que el barrido cree
   * mientras tanto (`ensureBase`, sin el plan) solo hace que aquí el abono
   * cuente como «sin tasa»: 409, nunca un saldo a favor.
   */
  private async paymentsCheck(
    tx: Prisma.TransactionClient,
    tenantId: string,
    item: { id: string; planId: string },
  ): Promise<FeeVoidPaymentsCheck> {
    const [plan] = await tx.$queryRaw<{ currency: string }[]>`
      SELECT "currency" FROM "treatment_plans"
       WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${item.planId}::uuid
         FOR UPDATE`;
    await tx.$queryRaw`
      SELECT "paymentId" FROM "payment_plan_amounts"
       WHERE "tenantId" = ${tenantId}::uuid
         AND "treatmentPlanId" = ${item.planId}::uuid
       ORDER BY "paymentId"
         FOR UPDATE`;
    await tx.$queryRaw`
      SELECT "id" FROM "treatment_plan_items"
       WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${item.id}::uuid
         FOR UPDATE`;
    // La base cuenta solo en la moneda que el plan tiene ahora (no cambia con
    // abonos vivos, pero una base en otra moneda tampoco se sumaría).
    const payments = await tx.$queryRaw<{ baseCents: bigint | null }[]>`
      SELECT round(b."amount" * 100)::bigint AS "baseCents"
        FROM "payments" pm
        LEFT JOIN "payment_plan_amounts" b
          ON b."tenantId" = pm."tenantId"
         AND b."paymentId" = pm."id"
         AND b."treatmentPlanId" = pm."treatmentPlanId"
         AND b."currency" = ${plan.currency}
       WHERE pm."tenantId" = ${tenantId}::uuid
         AND pm."treatmentPlanId" = ${item.planId}::uuid
         AND pm."deletedAt" IS NULL
         AND pm."voidedAt" IS NULL
       ORDER BY pm."id"`;
    const [rest] = await tx.$queryRaw<{ restCents: bigint }[]>`
      SELECT round(COALESCE(sum(i."price" - i."discount"), 0) * 100)::bigint
               AS "restCents"
        FROM "treatment_plan_items" i
       WHERE i."tenantId" = ${tenantId}::uuid
         AND i."planId" = ${item.planId}::uuid
         AND i."id" <> ${item.id}::uuid
         AND i."deletedAt" IS NULL
         AND i."status" <> 'PROPOSED'`;
    return voidPaymentsCheck(
      payments.map((p) => (p.baseCents === null ? null : Number(p.baseCents))),
      Number(rest.restCents),
    );
  }
}
