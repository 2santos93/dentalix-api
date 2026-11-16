import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TreatmentPlanStatus } from '@prisma/client';
import {
  isPlanBillable,
  notBillableMessage,
} from '../../../treatment-plans/domain/plan-status-machine';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CreatePaymentPlanRepoInput,
  PaymentPlanRepository,
} from '../../domain/ports/payment-plan-repository.port';
import { PaymentPlanWithInstallments } from '../../domain/entities/payment-plan.entity';
import { dueDayOf, paymentPlanLocationId } from '../../domain/installment-due';
import type { LockActor } from '../../../financial-lock/domain/financial-lock';
import {
  guardFinancialLock,
  openLockOverride,
  recordLockOverride,
} from '../../../financial-lock/infrastructure/financial-lock-tx';
import { loadTenantZones } from '../../../../shared/locations/reference-location';

/** DX-091: sede del plan (`null` = la principal) y su zona. */
interface PlanSite {
  locationId: string | null;
  timeZone: string;
}

type PrismaPaymentPlan = Prisma.PaymentPlanGetPayload<{
  include: { installments: true };
}>;

function mapToEntity(row: PrismaPaymentPlan): PaymentPlanWithInstallments {
  return {
    id: row.id,
    tenantId: row.tenantId,
    treatmentPlanId: row.treatmentPlanId,
    patientId: row.patientId,
    currency: row.currency,
    totalToFinance: row.totalToFinance.toNumber(),
    downPayment: row.downPayment.toNumber(),
    installmentsCount: row.installmentsCount,
    periodicity: row.periodicity,
    startDate: row.startDate,
    status: row.status,
    notes: row.notes,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    installments: [...row.installments]
      .sort((a, b) => a.sequence - b.sequence)
      .map((i) => ({
        id: i.id,
        sequence: i.sequence,
        dueDate: i.dueDate,
        amount: i.amount.toNumber(),
      })),
  };
}

@Injectable()
export class PrismaPaymentPlanRepository implements PaymentPlanRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // Same rationale as PrismaPaymentRepository.requireTenantId: INSERT needs
  // the tenant supplied explicitly (RLS only filters SELECT/UPDATE), read
  // from the same request context runWithTenant sets the GUC from.
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async create(
    input: CreatePaymentPlanRepoInput,
  ): Promise<PaymentPlanWithInstallments> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma.runWithTenant(async (tx) => {
      // DX-109 (BE-013): el plan se relee bloqueado (FOR SHARE) en la
      // transacción del alta: ni retirado ni rechazado/cancelado mientras
      // tanto. Cancelarlo (FOR UPDATE) espera a este COMMIT y cancela también
      // el plan de cuotas recién creado.
      const [plan] = await tx.$queryRaw<{ status: TreatmentPlanStatus }[]>`
        SELECT "status" FROM "treatment_plans"
         WHERE "id" = ${input.treatmentPlanId}::uuid
           AND "patientId" = ${input.patientId}::uuid
           AND "deletedAt" IS NULL
         FOR SHARE`;
      if (!plan) {
        throw new NotFoundException('Plan de tratamiento no encontrado');
      }
      if (!isPlanBillable(plan.status)) {
        throw new ConflictException(notBillableMessage(plan.status));
      }
      // DX-091: ninguna cuota puede vencer en un período contable cerrado
      // (antedatar cuotas mueve la cartera de meses ya cuadrados), salvo la
      // excepción del ADMIN con motivo.
      const site: { value?: PlanSite } = {};
      const lock = await guardFinancialLock(tx, {
        tenantId,
        operation: 'PAYMENT_PLAN_CREATE',
        probes: async () => {
          site.value = await this.planSite(tx, tenantId, input.treatmentPlanId);
          const { timeZone } = site.value;
          return input.installments.map((i) => ({
            day: dueDayOf(i.dueDate),
            timeZone,
          }));
        },
        now: new Date(),
        actor: input.lockActor ?? null,
      });
      // El id se fija aquí: con la excepción, el trigger de `installments`
      // tiene que reconocer el plan antes de que nazcan sus cuotas.
      const paymentPlanId = randomUUID();
      if (lock.decision.kind === 'override') {
        await openLockOverride(tx, [paymentPlanId]);
      }
      const created = await tx.paymentPlan.create({
        data: {
          id: paymentPlanId,
          tenantId,
          treatmentPlanId: input.treatmentPlanId,
          patientId: input.patientId,
          currency: input.currency,
          totalToFinance: input.totalToFinance,
          downPayment: input.downPayment,
          installmentsCount: input.installmentsCount,
          periodicity: input.periodicity,
          startDate: input.startDate,
          notes: input.notes,
          createdById: input.createdById,
          // Sin `tenantId` en las cuotas: con la FK compuesta
          // (tenantId, paymentPlanId) -> payment_plans(tenantId, id), el
          // tenantId de la cuota ES parte de la relación y Prisma lo hereda
          // del plan en el create anidado (pasarlo explícito es un error de
          // validación en runtime).
          installments: {
            create: input.installments.map((i) => ({
              sequence: i.sequence,
              dueDate: i.dueDate,
              amount: i.amount,
            })),
          },
        },
        include: { installments: true },
      });
      if (lock.decision.kind === 'override' && input.lockActor) {
        await recordLockOverride(tx, {
          tenantId,
          locationId: site.value?.locationId ?? null,
          operation: 'PAYMENT_PLAN_CREATE',
          paymentPlanId: created.id,
          businessDate: lock.day!,
          lockedThrough: lock.decision.through,
          reason: lock.decision.reason,
          actorUserId: input.lockActor.userId,
        });
      }
      return created;
    });
    return mapToEntity(row);
  }

  /**
   * DX-091: la sede del plan de tratamiento (la de su aceptación o su
   * presentación; `null` = la principal) y su zona, en la transacción.
   */
  private async planSite(
    tx: Prisma.TransactionClient,
    tenantId: string,
    treatmentPlanId: string,
  ): Promise<PlanSite> {
    const plan = await tx.treatmentPlan.findFirst({
      where: { id: treatmentPlanId, tenantId },
      select: { acceptedLocationId: true, presentedLocationId: true },
    });
    const locationId = plan ? paymentPlanLocationId(plan) : null;
    const zoneOf = await loadTenantZones(tx, tenantId);
    return { locationId, timeZone: zoneOf(locationId) };
  }

  async findActiveByPlan(
    treatmentPlanId: string,
  ): Promise<PaymentPlanWithInstallments | null> {
    const row = await this.prisma.runWithTenant(async (tx) => {
      return tx.paymentPlan.findFirst({
        where: { treatmentPlanId, status: 'ACTIVE', deletedAt: null },
        include: { installments: true },
      });
    });
    return row ? mapToEntity(row) : null;
  }

  async planTimeZone(treatmentPlanId: string): Promise<string> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const plan = await tx.treatmentPlan.findFirst({
        where: { id: treatmentPlanId, tenantId },
        select: { acceptedLocationId: true, presentedLocationId: true },
      });
      const zoneOf = await loadTenantZones(tx, tenantId);
      return zoneOf(plan ? paymentPlanLocationId(plan) : null);
    });
  }

  async cancel(id: string, lockActor?: LockActor | null): Promise<boolean> {
    const tenantId = this.requireTenantId();
    // Atomic check-and-set (mirrors PrismaPaymentRepository.softDelete):
    // UPDATE ... WHERE id AND status=ACTIVE AND deletedAt IS NULL, so two
    // concurrent cancels can't both "win".
    return this.prisma.runWithTenant(async (tx) => {
      // DX-091: cancelar deja sin efecto TODAS sus cuotas; si alguna venció
      // en un período contable cerrado, eso cambia lo que se debía en él.
      const plan = await tx.paymentPlan.findFirst({
        where: { id, status: 'ACTIVE', deletedAt: null },
        select: {
          treatmentPlanId: true,
          installments: { select: { dueDate: true } },
        },
      });
      if (!plan) return false;
      const site: { value?: PlanSite } = {};
      const lock = await guardFinancialLock(tx, {
        tenantId,
        operation: 'PAYMENT_PLAN_CANCEL',
        probes: async () => {
          site.value = await this.planSite(tx, tenantId, plan.treatmentPlanId);
          const { timeZone } = site.value;
          return plan.installments.map((i) => ({
            day: dueDayOf(i.dueDate),
            timeZone,
          }));
        },
        now: new Date(),
        actor: lockActor ?? null,
      });
      if (lock.decision.kind === 'override') {
        await openLockOverride(tx, [id]);
      }
      const result = await tx.paymentPlan.updateMany({
        where: { id, status: 'ACTIVE', deletedAt: null },
        data: { status: 'CANCELLED', deletedAt: new Date() },
      });
      if (result.count === 0) return false;
      if (lock.decision.kind === 'override' && lockActor) {
        await recordLockOverride(tx, {
          tenantId,
          locationId: site.value?.locationId ?? null,
          operation: 'PAYMENT_PLAN_CANCEL',
          paymentPlanId: id,
          businessDate: lock.day!,
          lockedThrough: lock.decision.through,
          reason: lock.decision.reason,
          actorUserId: lockActor.userId,
        });
      }
      return true;
    });
  }
}
