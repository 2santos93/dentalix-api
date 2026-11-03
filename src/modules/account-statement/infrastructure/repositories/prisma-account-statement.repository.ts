import { clinicLogoPublicUrl } from '../../../../shared/storage/clinic-logo-url';
import {
  CLINIC_FISCAL_SELECT,
  clinicFiscalOf,
} from '../../../../shared/clinic/clinic-fiscal';
import { Injectable } from '@nestjs/common';
import { Prisma, TreatmentPlanItemStatus } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  AccountStatementData,
  AccountStatementRepository,
} from '../../domain/ports/account-statement-repository.port';
import type { DocumentRegionalDto } from '../../../../shared/locations/document-regional.dto';
import { loadDocumentRegional } from '../../../../shared/locations/document-regional';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { BillablePlanRow } from '../../domain/entities/billable-plan.entity';
import { NON_BILLABLE_PLAN_STATUSES } from '../../../treatment-plans/domain/plan-status-machine';
import {
  catalogOf,
  methodRefOf,
} from '../../../payment-methods/domain/method-catalog';
import { round2 } from '../../../../shared/money/money';
import { linesTotal } from '../../../../shared/money/line-rounding';
import type { PlanBalanceInput } from '../../../payments/application/use-cases/get-plan-balance.use-case';
import { civilDateIn } from '../../../payments/domain/void-window';
import {
  FROZEN_RATE_SELECT,
  frozenRateOf,
} from '../../../payments/infrastructure/repositories/frozen-exchange-rate.mapper';

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

  async loadRegional(): Promise<DocumentRegionalDto | null> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return this.prisma.runWithTenant((tx) =>
      loadDocumentRegional(
        tx,
        tenantId,
        this.tenantContext.getLocationId() ?? null,
      ),
    );
  }

  /**
   * Número FIJO de consultas, sin importar cuántos planes, abonos o cuotas
   * tenga el paciente (sin N+1): paciente, planes, sus ítems cobrables, abonos
   * con su sede (Prisma resuelve la relación con un `IN` para todas las filas),
   * sus bases de imputación (DX-472), planes de pago con sus cuotas (ídem) y
   * saldos migrados vivos (DX-262), el catálogo de medios de pago (DX-395), más
   * el nombre de la clínica, y el nombre de quienes anularon abonos (una
   * consulta más, solo si hay anulaciones con autor).
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
  async load(
    patientId: string,
    options: { regional?: boolean } = {},
  ): Promise<AccountStatementData | null> {
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

        const [
          tenant,
          plans,
          items,
          payments,
          bases,
          paymentPlans,
          openings,
          creditSums,
        ] = await Promise.all([
          // `tenants` no tiene RLS (tabla global): se acota por el tenant del
          // contexto, igual que PrismaTenantBrandingRepository.
          tx.tenant.findFirst({
            where: { id: tenantId, deletedAt: null },
            select: { name: true, logoKey: true, ...CLINIC_FISCAL_SELECT },
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
          // Solo importes y estado: ningún dato clínico del ítem.
          tx.treatmentPlanItem.findMany({
            where: {
              deletedAt: null,
              status: { in: BILLABLE_ITEM_STATUSES },
              plan: livePlan,
            },
            select: {
              planId: true,
              status: true,
              price: true,
              discount: true,
            },
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
              externalInvoiceNumber: true,
              splitId: true,
              createdById: true,
              createdAt: true,
              deletedAt: true,
              voidedById: true,
              voidReason: true,
              location: { select: { id: true, name: true } },
              ...FROZEN_RATE_SELECT,
            },
          }),
          // DX-472: con base, un abono cuenta por ella (como en `/balance`).
          tx.paymentPlanAmount.findMany({
            where: {
              tenantId,
              payment: { patientId, deletedAt: null },
            },
            select: { paymentId: true, amount: true, currency: true },
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
          // DX-253: asientos del saldo a favor, sumados por plan y moneda.
          tx.patientCreditEntry.groupBy({
            by: ['treatmentPlanId', 'currency'],
            where: { patientId, plan: livePlan },
            _sum: { amount: true },
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

        const itemsByPlan = new Map<string, PlanBalanceInput['items']>();
        for (const item of items) {
          const list = itemsByPlan.get(item.planId) ?? [];
          list.push({
            status: item.status,
            price: item.price.toNumber(),
            discount: item.discount.toNumber(),
          });
          itemsByPlan.set(item.planId, list);
        }
        // DX-472-bis (revisión B1): una base cuenta solo si está en la moneda
        // de su plan (como el reparto de DX-051).
        const baseOf = (plan: { currency: string }) =>
          new Map(
            bases
              .filter((b) => b.currency === plan.currency)
              .map((b) => [b.paymentId, b.amount.toNumber()] as const),
          );

        // DX-354: la sede en contexto o, en «Todas las sedes», la principal.
        const regional =
          options.regional === false
            ? null
            : await loadDocumentRegional(
                tx,
                tenantId,
                this.tenantContext.getLocationId() ?? null,
              );

        return {
          regional,
          clinic: {
            name: tenant?.name ?? '',
            logoUrl: clinicLogoPublicUrl(tenant?.logoKey ?? null),
            fiscal: clinicFiscalOf(tenant),
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
              billable: linesTotal(itemsByPlan.get(plan.id) ?? []),
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
              externalInvoiceNumber: p.externalInvoiceNumber,
              splitId: p.splitId,
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
            creditEntries: creditSums.map((c) => ({
              treatmentPlanId: c.treatmentPlanId,
              currency: c.currency,
              amount: c._sum.amount?.toNumber() ?? 0,
            })),
          },
          planBalances: plans.map((plan) => ({
            plan,
            items: itemsByPlan.get(plan.id) ?? [],
            payments: payments
              .filter((p) => p.treatmentPlanId === plan.id && !p.deletedAt)
              .map((p) => ({
                id: p.id,
                amount: p.amount.toNumber(),
                currency: p.currency,
                paidOn: civilDateIn(p.paidAt, timeZoneOf(p.location.id)),
                exchangeRateCurrency: p.exchangeRateCurrency,
                frozenRate: frozenRateOf(p),
              })),
            baseOf: baseOf(plan),
            creditMovements:
              creditSums
                .find(
                  (c) =>
                    c.treatmentPlanId === plan.id &&
                    c.currency === plan.currency,
                )
                ?._sum.amount?.toNumber() ?? 0,
          })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * Planes cobrables (DX-067): consultas fijas, sin N+1 — paciente, planes no
   * cancelados, suma de ítems facturables por plan (`groupBy`), abonos vivos
   * de esos planes con su tasa congelada y sus bases (DX-472-bis: el saldo
   * convertido de `/balance`), asientos del saldo a favor, planes de pago
   * activos y la zona de las sedes de los abonos. Mismo `runWithTenant` (RLS) y `patientId` en cada `where` que
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

        const [
          plans,
          itemSums,
          payments,
          activePaymentPlans,
          bases,
          creditSums,
        ] = await Promise.all([
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
          // DX-472-bis: uno a uno (no sumados) para el saldo convertido,
          // con su tasa congelada y su sede, como `load`.
          tx.payment.findMany({
            where: { patientId, deletedAt: null, plan: billablePlan },
            select: {
              id: true,
              treatmentPlanId: true,
              amount: true,
              currency: true,
              paidAt: true,
              locationId: true,
              ...FROZEN_RATE_SELECT,
            },
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
          // DX-472-bis: con base, un abono cuenta por ella (como en `load`).
          tx.paymentPlanAmount.findMany({
            where: {
              tenantId,
              payment: { patientId, deletedAt: null, plan: billablePlan },
            },
            select: { paymentId: true, amount: true, currency: true },
          }),
          // DX-253: el saldo a favor traspasado o devuelto cuenta como
          // abonado del plan (en su moneda).
          tx.patientCreditEntry.groupBy({
            by: ['treatmentPlanId', 'currency'],
            where: { patientId, plan: billablePlan },
            _sum: { amount: true },
          }),
        ]);

        const billableByPlan = new Map(
          itemSums.map((row) => [row.planId, netOf(row._sum)]),
        );
        const paidByPlan = new Map<
          string,
          { currency: string; amount: number }[]
        >();
        for (const p of payments) {
          // El filtro `plan: billablePlan` ya deja fuera los abonos a un saldo
          // migrado (DX-262), que no tienen plan.
          if (!p.treatmentPlanId) continue;
          const list = paidByPlan.get(p.treatmentPlanId) ?? [];
          const amount = p.amount.toNumber();
          const same = list.find((x) => x.currency === p.currency);
          if (same) same.amount = round2(same.amount + amount);
          else list.push({ currency: p.currency, amount });
          paidByPlan.set(p.treatmentPlanId, list);
        }
        for (const row of creditSums) {
          const list = paidByPlan.get(row.treatmentPlanId) ?? [];
          const amount = row._sum.amount?.toNumber() ?? 0;
          const same = list.find((p) => p.currency === row.currency);
          if (same) same.amount = round2(same.amount + amount);
          else list.push({ currency: row.currency, amount });
          paidByPlan.set(row.treatmentPlanId, list);
        }
        const withActivePaymentPlan = new Set(
          activePaymentPlans.map((pp) => pp.treatmentPlanId),
        );

        // Día civil de cada abono en su sede (DX-097): el de su tasa.
        const timeZoneOf = await resolveLocationTimeZones(
          tx,
          tenantId,
          payments.map((p) => p.locationId),
        );
        // DX-472-bis (revisión B1): una base cuenta solo si está en la moneda
        // de su plan (como el reparto de DX-051).
        const baseOf = (plan: { currency: string }) =>
          new Map(
            bases
              .filter((b) => b.currency === plan.currency)
              .map((b) => [b.paymentId, b.amount.toNumber()] as const),
          );

        return plans.map((plan) => ({
          ...plan,
          billable: billableByPlan.get(plan.id) ?? 0,
          paidByCurrency: paidByPlan.get(plan.id) ?? [],
          hasActivePaymentPlan: withActivePaymentPlan.has(plan.id),
          // DX-472-bis: el saldo del plan con la cuenta de `/balance`.
          balanceInput: {
            plan,
            items: [],
            billable: billableByPlan.get(plan.id) ?? 0,
            payments: payments
              .filter((p) => p.treatmentPlanId === plan.id)
              .map((p) => ({
                id: p.id,
                amount: p.amount.toNumber(),
                currency: p.currency,
                paidOn: civilDateIn(p.paidAt, timeZoneOf(p.locationId)),
                exchangeRateCurrency: p.exchangeRateCurrency,
                frozenRate: frozenRateOf(p),
              })),
            baseOf: baseOf(plan),
            creditMovements:
              creditSums
                .find(
                  (c) =>
                    c.treatmentPlanId === plan.id &&
                    c.currency === plan.currency,
                )
                ?._sum.amount?.toNumber() ?? 0,
          },
        }));
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
