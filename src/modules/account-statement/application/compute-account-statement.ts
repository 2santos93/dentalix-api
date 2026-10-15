import { TreatmentPlanStatus } from '@prisma/client';
import {
  deriveStatuses,
  ScheduleTramo,
} from '../../payment-plans/application/schedule/derive-statuses';
import {
  ComputedAccountStatement,
  StatementCurrencySummary,
  StatementInstallment,
  StatementMovement,
  StatementNextInstallment,
  StatementPaymentPlanRow,
  StatementPaymentRow,
  StatementPlanLine,
  StatementSnapshot,
} from '../domain/entities/account-statement.entity';

export interface ComputeAccountStatementOptions {
  /** "Hoy" para decidir qué cuota está vencida (inyectado, nunca el reloj). */
  today: Date;
  /** Filtro de `movements`, inclusive (medianoche UTC del primer día). */
  movementsFrom?: Date;
  /** Filtro de `movements`, EXCLUSIVO (medianoche UTC del día siguiente al último). */
  movementsToExclusive?: Date;
}

/*
 * CRITERIOS (documentados también en el informe DX-011):
 *
 * - Presupuestado = Σ ítems vivos ACCEPTED|DONE de los planes NO cancelados. Es
 *   el mismo "facturable" de GetPlanBalanceUseCase: un ítem PROPOSED todavía no
 *   se debe, así que un DRAFT sin ítems aceptados suma 0 por sí solo. El esquema
 *   no tiene estado "rechazado"; CANCELLED es el único que saca un plan del
 *   saldo. COMPLETED sí cuenta (lo hecho se debe hasta que se pague).
 * - Abonado = Σ abonos NO anulados, de cualquier plan (también de uno
 *   cancelado: ese dinero se recibió y queda a favor del paciente).
 * - Por moneda y SIN convertir. Cada cifra va en la moneda en que se presupuestó
 *   o se pagó. Convertir exigiría una tasa por abono (una consulta por fila) y
 *   mezclaría cifras de mercado con lo que el paciente de verdad entregó; un
 *   abono en otra moneda que la del plan se informa aparte en ese plan
 *   (`paidOtherCurrencies`) y no cubre sus cuotas.
 * - Cuotas: las de los planes de pago vivos de planes no cancelados, con el
 *   mismo reparto voraz y los mismos estados que GetPaymentPlanUseCase
 *   (deriveStatuses): lo abonado al plan en la moneda del plan de pagos cubre
 *   primero la cuota inicial y luego las cuotas en orden.
 * - Próxima cuota = la de vencimiento más cercano que todavía no venció ni está
 *   pagada (las vencidas ya se cuentan aparte).
 */

// Montos Decimal(14,2): sumar en centavos enteros es exacto (mismo criterio que
// ListCashPaymentsUseCase).
function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function fromCents(cents: number): number {
  return cents / 100;
}

function countsTowardsBalance(status: TreatmentPlanStatus): boolean {
  return status !== TreatmentPlanStatus.CANCELLED;
}

function isActive(payment: StatementPaymentRow): boolean {
  return payment.voidedAt === null;
}

interface CurrencyAccumulator {
  budgetedCents: number;
  paidCents: number;
  overdueCount: number;
  overdueCents: number;
  next: StatementNextInstallment | null;
  hasInstallments: boolean;
}

function emptyAccumulator(): CurrencyAccumulator {
  return {
    budgetedCents: 0,
    paidCents: 0,
    overdueCount: 0,
    overdueCents: 0,
    next: null,
    hasInstallments: false,
  };
}

function buildTramos(paymentPlan: StatementPaymentPlanRow): ScheduleTramo[] {
  const tramos: ScheduleTramo[] = [];
  if (paymentPlan.downPayment > 0) {
    tramos.push({
      kind: 'DOWN_PAYMENT',
      sequence: null,
      dueDate: paymentPlan.startDate,
      amount: paymentPlan.downPayment,
    });
  }
  for (const inst of [...paymentPlan.installments].sort(
    (a, b) => a.sequence - b.sequence,
  )) {
    tramos.push({
      kind: 'INSTALLMENT',
      sequence: inst.sequence,
      dueDate: inst.dueDate,
      amount: inst.amount,
    });
  }
  return tramos;
}

/** Abonado vivo de un plan, en centavos, agrupado por moneda. */
function paidByPlanAndCurrency(
  payments: StatementPaymentRow[],
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const p of payments) {
    if (!isActive(p)) continue;
    const byCurrency = out.get(p.treatmentPlanId) ?? new Map<string, number>();
    byCurrency.set(
      p.currency,
      (byCurrency.get(p.currency) ?? 0) + toCents(p.amount),
    );
    out.set(p.treatmentPlanId, byCurrency);
  }
  return out;
}

function inRange(
  paidAt: Date,
  from: Date | undefined,
  toExclusive: Date | undefined,
): boolean {
  const t = paidAt.getTime();
  return (
    (from === undefined || t >= from.getTime()) &&
    (toExclusive === undefined || t < toExclusive.getTime())
  );
}

export function computeAccountStatement(
  snapshot: StatementSnapshot,
  options: ComputeAccountStatementOptions,
): ComputedAccountStatement {
  const currencies = new Map<string, CurrencyAccumulator>();
  const acc = (currency: string): CurrencyAccumulator => {
    const existing = currencies.get(currency);
    if (existing) return existing;
    const created = emptyAccumulator();
    currencies.set(currency, created);
    return created;
  };

  const paidByPlan = paidByPlanAndCurrency(snapshot.payments);
  const planById = new Map(snapshot.plans.map((p) => [p.id, p]));

  // --- Planes -------------------------------------------------------------
  const plans: StatementPlanLine[] = snapshot.plans.map((plan) => {
    const counts = countsTowardsBalance(plan.status);
    const budgetedCents = toCents(plan.billable);
    const paidMap = paidByPlan.get(plan.id) ?? new Map<string, number>();
    const paidCents = paidMap.get(plan.currency) ?? 0;
    if (counts) {
      acc(plan.currency).budgetedCents += budgetedCents;
    }
    return {
      id: plan.id,
      status: plan.status,
      currency: plan.currency,
      createdAt: plan.createdAt,
      budgeted: fromCents(budgetedCents),
      countsTowardsBalance: counts,
      paid: fromCents(paidCents),
      paidOtherCurrencies: [...paidMap.entries()]
        .filter(([currency]) => currency !== plan.currency)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, cents]) => ({ currency, amount: fromCents(cents) })),
      balance: fromCents((counts ? budgetedCents : 0) - paidCents),
    };
  });

  // --- Abonado por moneda ---------------------------------------------------
  for (const p of snapshot.payments) {
    if (isActive(p)) {
      acc(p.currency).paidCents += toCents(p.amount);
    }
  }

  // --- Cuotas -----------------------------------------------------------------
  const installments: StatementInstallment[] = [];
  for (const paymentPlan of snapshot.paymentPlans) {
    const treatmentPlan = planById.get(paymentPlan.treatmentPlanId);
    if (!treatmentPlan || !countsTowardsBalance(treatmentPlan.status)) {
      continue;
    }
    const paidCents =
      paidByPlan.get(paymentPlan.treatmentPlanId)?.get(paymentPlan.currency) ??
      0;
    const derived = deriveStatuses(
      buildTramos(paymentPlan),
      fromCents(paidCents),
      options.today,
    );
    const currencyAcc = acc(paymentPlan.currency);
    currencyAcc.hasInstallments ||= derived.length > 0;

    for (const tramo of derived) {
      const outstandingCents = Math.max(
        toCents(tramo.amount) - toCents(tramo.covered),
        0,
      );
      installments.push({
        paymentPlanId: paymentPlan.id,
        treatmentPlanId: paymentPlan.treatmentPlanId,
        currency: paymentPlan.currency,
        kind: tramo.kind,
        sequence: tramo.sequence,
        dueDate: tramo.dueDate,
        amount: tramo.amount,
        covered: tramo.covered,
        outstanding: fromCents(outstandingCents),
        status: tramo.status,
      });

      if (tramo.status === 'OVERDUE') {
        currencyAcc.overdueCount += 1;
        currencyAcc.overdueCents += outstandingCents;
      } else if (
        (tramo.status === 'PENDING' || tramo.status === 'PARTIAL') &&
        (currencyAcc.next === null ||
          tramo.dueDate.getTime() < currencyAcc.next.dueDate.getTime())
      ) {
        currencyAcc.next = {
          treatmentPlanId: paymentPlan.treatmentPlanId,
          sequence: tramo.sequence,
          dueDate: tramo.dueDate,
          amount: fromCents(outstandingCents),
        };
      }
    }
  }
  installments.sort(
    (a, b) =>
      a.dueDate.getTime() - b.dueDate.getTime() ||
      a.treatmentPlanId.localeCompare(b.treatmentPlanId) ||
      (a.sequence ?? 0) - (b.sequence ?? 0),
  );

  // --- Movimientos ----------------------------------------------------------
  const movements: StatementMovement[] = snapshot.payments
    .filter((p) =>
      inRange(p.paidAt, options.movementsFrom, options.movementsToExclusive),
    )
    .map((p) => ({
      id: p.id,
      paidAt: p.paidAt,
      amount: p.amount,
      currency: p.currency,
      method: p.method,
      location: p.location,
      treatmentPlanId: p.treatmentPlanId,
      voided: p.voidedAt !== null,
      voidedAt: p.voidedAt,
    }))
    .sort(
      (a, b) =>
        b.paidAt.getTime() - a.paidAt.getTime() || b.id.localeCompare(a.id),
    );

  // --- Resumen ----------------------------------------------------------------
  const summary: StatementCurrencySummary[] = [...currencies.entries()]
    .filter(
      ([, a]) =>
        a.budgetedCents !== 0 || a.paidCents !== 0 || a.hasInstallments,
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, a]) => ({
      currency,
      budgeted: fromCents(a.budgetedCents),
      paid: fromCents(a.paidCents),
      balance: fromCents(a.budgetedCents - a.paidCents),
      overdueCount: a.overdueCount,
      overdueAmount: fromCents(a.overdueCents),
      nextInstallment: a.next,
    }));

  return { summary, plans, movements, installments };
}
