import { Injectable } from '@nestjs/common';
import { Prisma, TreatmentPlanItemStatus } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  AccountStatementData,
  AccountStatementRepository,
} from '../../domain/ports/account-statement-repository.port';

// Mismo "facturable" que GetPlanBalanceUseCase: un ítem PROPOSED aún no se debe.
const BILLABLE_ITEM_STATUSES: TreatmentPlanItemStatus[] = [
  TreatmentPlanItemStatus.ACCEPTED,
  TreatmentPlanItemStatus.DONE,
];

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
   * para todas las filas) y planes de pago con sus cuotas (ídem), más el nombre
   * de la clínica.
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
            docType: true,
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

        const [tenant, plans, itemSums, payments, paymentPlans] =
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
              _sum: { price: true },
            }),
            // Anulados INCLUIDOS (sin filtro de deletedAt): el estado de cuenta
            // los lista marcados; el cálculo no los suma.
            tx.payment.findMany({
              where: { patientId, plan: livePlan },
              select: {
                id: true,
                treatmentPlanId: true,
                amount: true,
                currency: true,
                paidAt: true,
                method: true,
                deletedAt: true,
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
          ]);

        const billableByPlan = new Map(
          itemSums.map((row) => [row.planId, row._sum.price?.toNumber() ?? 0]),
        );

        return {
          clinic: {
            name: tenant?.name ?? '',
            logoUrl: tenant?.logoUrl ?? null,
          },
          patient,
          snapshot: {
            plans: plans.map((plan) => ({
              ...plan,
              billable: billableByPlan.get(plan.id) ?? 0,
            })),
            payments: payments.map((p) => ({
              id: p.id,
              treatmentPlanId: p.treatmentPlanId,
              amount: p.amount.toNumber(),
              currency: p.currency,
              paidAt: p.paidAt,
              method: p.method,
              location: p.location,
              voidedAt: p.deletedAt,
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
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
