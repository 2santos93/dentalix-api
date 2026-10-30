import { Injectable } from '@nestjs/common';
import { Prisma, TreatmentPlanItemStatus } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  AccountStatementData,
  AccountStatementRepository,
} from '../../domain/ports/account-statement-repository.port';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { BillablePlanRow } from '../../domain/entities/billable-plan.entity';
import { NON_BILLABLE_PLAN_STATUSES } from '../../../treatment-plans/domain/plan-status-machine';
import {
  catalogOf,
  methodRefOf,
} from '../../../payment-methods/domain/method-catalog';

// Mismo "facturable" que GetPlanBalanceUseCase: un ítem PROPOSED aún no se debe.
const BILLABLE_ITEM_STATUSES: TreatmentPlanItemStatus[] = [
  TreatmentPlanItemStatus.ACCEPTED,
  TreatmentPlanItemStatus.DONE,
];

/** Facturable de un plan: Σ precio − Σ descuento de sus ítems (DX-012). */
function netOf(sum: {
  price: Prisma.Decimal | null;
  discount: Prisma.Decimal | null;
}): number {
  const price = sum.price ?? new Prisma.Decimal(0);
  return price.minus(sum.discount ?? 0).toNumber();
}

@Injectable()
export class PrismaAccountStatementRepository implements AccountStatementRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Número FIJO de consultas, sin importar cuántos planes, abonos o cuotas
   * tenga el paciente (sin N+1): paciente, planes, suma de ítems por plan
   * (`groupBy`), abonos con su sede (Prisma resuelve la relación con un `IN`
   * para todas las filas), planes de pago con sus cuotas (ídem) y saldos
   * migrados vivos (DX-262), el catálogo de medios de pago (DX-395), más el nombre
   * de la clínica, y el nombre de quienes anularon abonos (una consulta más,
   * solo si hay anulaciones con autor).
   *
   * Todo bajo `runWithTenant` (RLS por `app.current_tenant`) Y con
   * `patientId` en cada `where`: aunque una política RLS se rompiera, ninguna
   * consulta lee fuera de este paciente. REPEATABLE READ para que el resumen y
   * el detalle describan la misma foto aunque se registre un abono a mitad de
   * la lectura (mismo criterio que la caja).
   *
   * NO filtra por sede: el estado de cuenta es del paciente, que es de la
   * clínica (ver PrismaPaymentRepository.listByPatient).
   */
  async load(patientId: string): Promise<AccountStatementData | null> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }

    return this.prisma.runWithTenant(
      async (tx) => {
        const patient = await tx.patient.findFirst({
          where: { id: patientId, deletedAt: null },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            documentType: true,
            docTypeLabel: true,
            docNumber: true,
          },
        });
        if (!patient) {
          return null;
        }

        const livePlan: Prisma.TreatmentPlanWhereInput = {
          patientId,
          deletedAt: null,
        };

        const [tenant, plans, itemSums, payments, paymentPlans, openings] =
          await Promise.all([
            // `tenants` no tiene RLS (tabla global): se acota por el tenant del
            // contexto, igual que PrismaTenantBrandingRepository.
            tx.tenant.findFirst({
              where: { id: tenantId, deletedAt: null },
              select: { name: true, logoUrl: true },
            }),
            tx.treatmentPlan.findMany({
              where: livePlan,
              select: {
                id: true,
                status: true,
                currency: true,
                createdAt: true,
              },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            }),
            tx.treatmentPlanItem.groupBy({
              by: ['planId'],
              where: {
                deletedAt: null,
                status: { in: BILLABLE_ITEM_STATUSES },
                plan: livePlan,
              },
              _sum: { price: true, discount: true },
            }),
            // Anulados INCLUIDOS (sin filtro de deletedAt): el estado de cuenta
            // los lista marcados; el cálculo no los suma.
            // DX-262: también los abonos contra un saldo migrado (sin plan).
            tx.payment.findMany({
              where: {
                patientId,
                OR: [{ plan: livePlan }, { openingBalanceId: { not: null } }],
              },
              select: {
                id: true,
                treatmentPlanId: true,
                openingBalanceId: true,
                amount: true,
                currency: true,
                paidAt: true,
                method: true,
                paymentMethodId: true,
                reference: true,
                createdById: true,
                createdAt: true,
                deletedAt: true,
                voidedById: true,
                voidReason: true,
                location: { select: { id: true, name: true } },
              },
            }),
            // Un plan de pagos cancelado lleva status CANCELLED + deletedAt
            // (PrismaPaymentPlanRepository.cancel): fuera.
            tx.paymentPlan.findMany({
              where: {
                patientId,
                deletedAt: null,
                status: { not: 'CANCELLED' },
                plan: livePlan,
              },
              select: {
                id: true,
                treatmentPlanId: true,
                currency: true,
                status: true,
                downPayment: true,
                startDate: true,
                installments: {
                  select: { sequence: true, dueDate: true, amount: true },
                  orderBy: { sequence: 'asc' },
                },
              },
            }),
            // DX-262: saldos migrados vivos (los de un lote deshecho, fuera).
            tx.openingBalance.findMany({
              where: { patientId, voidedAt: null },
              select: {
                id: true,
                currency: true,
                amount: true,
                asOfDate: true,
                asOfDateApproximate: true,
                concept: true,
                importBatchId: true,
              },
              orderBy: [{ asOfDate: 'asc' }, { id: 'asc' }],
            }),
          ]);

        // DX-395: el catálogo de medios de la clínica (RLS y `tenantId`),
        // corto, para nombrar el medio de cada abono; también los inactivos,
        // porque un abono antiguo conserva el suyo. Un abono sin medio de una
        // réplica anterior se nombra con el inicial de su método, como la caja.
        const catalog = catalogOf(
          await tx.clinicPaymentMethod.findMany({
            where: { tenantId },
            select: { id: true, name: true, legacyMethod: true },
          }),
        );

        // Nombre de quien anuló cada abono (SEC-013): UNA consulta para todos.
        // El usuario es global; su nombre se lee a través de la membresía, que
        // tiene RLS, así que solo aparece si es (o fue) de esta clínica. Sin
        // filtrar `deletedAt`: si dejó la clínica, la anulación sigue siendo
        // suya.
        const voiderIds = [
          ...new Set(
            payments.flatMap((p) => (p.voidedById ? [p.voidedById] : [])),
          ),
        ];
        const voiders =
          voiderIds.length === 0
            ? []
            : await tx.clinicMembership.findMany({
                // `tenantId` además de RLS, como `patientId` en el resto.
                where: { tenantId, userId: { in: voiderIds } },
                select: { userId: true, user: { select: { fullName: true } } },
              });
        const voiderName = new Map(
          voiders.map((m) => [m.userId, m.user.fullName]),
        );

        // Zona de cada sede de los abonos (UNA consulta): el `canVoid` de cada
        // movimiento usa el mismo "hoy" que la anulación (DX-057).
        const timeZoneOf = await resolveLocationTimeZones(
          tx,
          tenantId,
          payments.map((p) => p.location.id),
        );

        const billableByPlan = new Map(
          itemSums.map((row) => [row.planId, netOf(row._sum)]),
        );

        return {
          clinic: {
            name: tenant?.name ?? '',
            logoUrl: tenant?.logoUrl ?? null,
          },
          patient: {
            id: patient.id,
            firstName: patient.firstName,
            lastName: patient.lastName,
            docType: patient.documentType,
            docTypeLabel: patient.docTypeLabel,
            docNumber: patient.docNumber,
          },
          snapshot: {
            plans: plans.map((plan) => ({
              ...plan,
              billable: billableByPlan.get(plan.id) ?? 0,
            })),
            payments: payments.map((p) => ({
              id: p.id,
              treatmentPlanId: p.treatmentPlanId,
              openingBalanceId: p.openingBalanceId,
              amount: p.amount.toNumber(),
              currency: p.currency,
              paidAt: p.paidAt,
              method: p.method,
              paymentMethod: methodRefOf(catalog, p.paymentMethodId, p.method),
              reference: p.reference,
              location: p.location,
              createdById: p.createdById,
              createdAt: p.createdAt,
              timeZone: timeZoneOf(p.location.id),
              voidedAt: p.deletedAt,
              voidedBy: p.voidedById
                ? {
                    id: p.voidedById,
                    fullName: voiderName.get(p.voidedById) ?? null,
                  }
                : null,
              voidReason: p.voidReason,
            })),
            paymentPlans: paymentPlans.map((pp) => ({
              id: pp.id,
              treatmentPlanId: pp.treatmentPlanId,
              currency: pp.currency,
              status: pp.status,
              downPayment: pp.downPayment.toNumber(),
              startDate: pp.startDate,
              installments: pp.installments.map((i) => ({
                sequence: i.sequence,
                dueDate: i.dueDate,
                amount: i.amount.toNumber(),
              })),
            })),
            openingBalances: openings.map((o) => ({
              ...o,
              amount: o.amount.toNumber(),
              asOfDate: o.asOfDate.toISOString().slice(0, 10),
            })),
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * Planes cobrables (DX-067): CUATRO consultas fijas, sin N+1 — paciente,
   * planes no cancelados, suma de ítems facturables por plan (`groupBy`) y
   * suma de abonos vivos por plan y moneda (`groupBy`), más los planes de pago
   * activos. Mismo `runWithTenant` (RLS) y `patientId` en cada `where` que
   * `load`; los índices `(tenantId, patientId)` de treatment_plans, payments y
   * payment_plans y `(tenantId, planId)` de los ítems cubren los filtros.
   *
   * Los `select` son la frontera de lo clínico: de los planes solo salen id,
   * estado, moneda y fecha; de los ítems, solo la suma de su precio.
   *
   * Tampoco filtra por sede: el plan y su saldo son del paciente, que es de la
   * clínica (igual que el estado de cuenta). La sede solo decide dónde se
   * registra el abono nuevo (`X-Location-Id` en el POST).
   */
  async loadBillablePlans(
    patientId: string,
  ): Promise<BillablePlanRow[] | null> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }

    return this.prisma.runWithTenant(
      async (tx) => {
        const patient = await tx.patient.findFirst({
          where: { id: patientId, deletedAt: null },
          select: { id: true },
        });
        if (!patient) {
          return null;
        }

        const billablePlan: Prisma.TreatmentPlanWhereInput = {
          patientId,
          deletedAt: null,
          // Cancelado o rechazado (DX-040): no se cobra.
          status: { notIn: [...NON_BILLABLE_PLAN_STATUSES] },
        };

        const [plans, itemSums, paidSums, activePaymentPlans] =
          await Promise.all([
            tx.treatmentPlan.findMany({
              where: billablePlan,
              select: {
                id: true,
                status: true,
                currency: true,
                createdAt: true,
              },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            }),
            tx.treatmentPlanItem.groupBy({
              by: ['planId'],
              where: {
                deletedAt: null,
                status: { in: BILLABLE_ITEM_STATUSES },
                plan: billablePlan,
              },
              _sum: { price: true, discount: true },
            }),
            tx.payment.groupBy({
              by: ['treatmentPlanId', 'currency'],
              where: { patientId, deletedAt: null, plan: billablePlan },
              _sum: { amount: true },
            }),
            tx.paymentPlan.findMany({
              where: {
                patientId,
                status: 'ACTIVE',
                deletedAt: null,
                plan: billablePlan,
              },
              select: { treatmentPlanId: true },
            }),
          ]);

        const billableByPlan = new Map(
          itemSums.map((row) => [row.planId, netOf(row._sum)]),
        );
        const paidByPlan = new Map<
          string,
          { currency: string; amount: number }[]
        >();
        for (const row of paidSums) {
          // El filtro `plan: billablePlan` ya deja fuera los abonos a un saldo
          // migrado (DX-262), que no tienen plan.
          if (!row.treatmentPlanId) continue;
          const list = paidByPlan.get(row.treatmentPlanId) ?? [];
          list.push({
            currency: row.currency,
            amount: row._sum.amount?.toNumber() ?? 0,
          });
          paidByPlan.set(row.treatmentPlanId, list);
        }
        const withActivePaymentPlan = new Set(
          activePaymentPlans.map((pp) => pp.treatmentPlanId),
        );

        return plans.map((plan) => ({
          ...plan,
          billable: billableByPlan.get(plan.id) ?? 0,
          paidByCurrency: paidByPlan.get(plan.id) ?? [],
          hasActivePaymentPlan: withActivePaymentPlan.has(plan.id),
        }));
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
