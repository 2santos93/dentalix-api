import { TreatmentPlanStatus } from '@prisma/client';
import {
  deriveStatuses,
  ScheduleTramo,
} from '../../payment-plans/application/schedule/derive-statuses';
import {
  BalancePaymentRow,
  BalanceSnapshot,
  ComputedAccountStatement,
  ComputedBalances,
  StatementCurrencySummary,
  StatementInstallment,
  StatementMovement,
  StatementNextInstallment,
  StatementPaymentPlanRow,
  StatementPlanLine,
  StatementSnapshot,
} from '../domain/entities/account-statement.entity';
import {
  canVoidPayment,
  civilDateIn,
  type VoidActor,
} from '../../payments/domain/void-window';
import { isPlanBillable } from '../../treatment-plans/domain/plan-status-machine';
import { fromCents, toCents } from '../../../shared/money/money';

export interface ComputeAccountStatementOptions {
  /** "Hoy" para decidir qué cuota está vencida (inyectado, nunca el reloj). */
  today: Date;
  /**
   * Quién consulta: decide `canVoid` de cada movimiento con la regla de
   * anulación y `today` como "ahora". Sin él, ningún movimiento es anulable.
   */
  voidActor?: VoidActor;
  /** Filtro de `movements`: primer día civil (YYYY-MM-DD), inclusive. */
  movementsFrom?: string;
  /** Filtro de `movements`: último día civil (YYYY-MM-DD), inclusive. */
  movementsTo?: string;
}

/*
 * CRITERIOS (documentados también en el informe DX-011):
 *
 * - Presupuestado = Σ ítems vivos ACCEPTED|DONE de los planes NO cancelados. Es
 *   el mismo "facturable" de GetPlanBalanceUseCase: un ítem PROPOSED todavía no
 *   se debe, así que un DRAFT sin ítems aceptados suma 0 por sí solo. El esquema
 *   CANCELLED y REJECTED (el paciente no lo aceptó, DX-040) sacan un plan del
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
 * - Saldo migrado (DX-262) = deuda traída del programa anterior, por moneda:
 *   va aparte de lo presupuestado (`openingBalance`) y suma al saldo:
 *   `balance = budgeted + openingBalance − paid`. Un abono va a un plan O a
 *   un saldo migrado: el de un saldo cuenta en `paid` de su moneda y en el
 *   abonado/pendiente de ese saldo, nunca en un plan ni en sus cuotas.
 * - Saldo a favor (DX-253): los traspasos y devoluciones son asientos con
 *   signo en la moneda del plan (`creditEntries`) que se suman a lo abonado
 *   del plan (y de su moneda en el resumen) sin tocar los abonos:
 *   `balance = budgeted + openingBalance − paid − creditMovements`.
 * - Próxima cuota = la de vencimiento más cercano que todavía no venció ni está
 *   pagada (las vencidas ya se cuentan aparte).
 */

function countsTowardsBalance(status: TreatmentPlanStatus): boolean {
  return isPlanBillable(status);
}

function isActive(payment: BalancePaymentRow): boolean {
  return payment.voidedAt === null;
}

interface CurrencyAccumulator {
  budgetedCents: number;
  openingCents: number;
  openingPendingCents: number;
  paidCents: number;
  creditCents: number;
  overdueCount: number;
  overdueCents: number;
  next: StatementNextInstallment | null;
  hasInstallments: boolean;
}

function emptyAccumulator(): CurrencyAccumulator {
  return {
    budgetedCents: 0,
    openingCents: 0,
    openingPendingCents: 0,
    paidCents: 0,
    creditCents: 0,
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
  payments: readonly BalancePaymentRow[],
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const p of payments) {
    if (!isActive(p) || p.treatmentPlanId === null) continue;
    const byCurrency = out.get(p.treatmentPlanId) ?? new Map<string, number>();
    byCurrency.set(
      p.currency,
      (byCurrency.get(p.currency) ?? 0) + toCents(p.amount),
    );
    out.set(p.treatmentPlanId, byCurrency);
  }
  return out;
}

// Días civiles YYYY-MM-DD: el orden de texto es el del calendario.
function inRange(
  paidOn: string,
  from: string | undefined,
  to: string | undefined,
): boolean {
  return (
    (from === undefined || paidOn >= from) && (to === undefined || paidOn <= to)
  );
}

/**
 * El núcleo del saldo: resumen por moneda, saldo por plan y cuotas con su
 * estado. Es EL cálculo del saldo del paciente: el estado de cuenta (DX-011) lo
 * usa tal cual y la cartera por antigüedad (DX-145) lo reparte en tramos, así
 * que las dos cifras no pueden divergir. `payments` puede traer abonos sueltos
 * o ya sumados por plan y moneda: solo se suman los vivos.
 */
export function computeBalances(
  snapshot: BalanceSnapshot,
  today: Date,
): ComputedBalances {
  const currencies = new Map<string, CurrencyAccumulator>();
  const acc = (currency: string): CurrencyAccumulator => {
    const existing = currencies.get(currency);
    if (existing) return existing;
    const created = emptyAccumulator();
    currencies.set(currency, created);
    return created;
  };

  const paidByPlan = paidByPlanAndCurrency(snapshot.payments);
  // DX-253: asientos del saldo a favor por plan y moneda (con signo).
  const creditByPlan = new Map<string, Map<string, number>>();
  for (const entry of snapshot.creditEntries ?? []) {
    const byCurrency =
      creditByPlan.get(entry.treatmentPlanId) ?? new Map<string, number>();
    byCurrency.set(
      entry.currency,
      (byCurrency.get(entry.currency) ?? 0) + toCents(entry.amount),
    );
    creditByPlan.set(entry.treatmentPlanId, byCurrency);
    acc(entry.currency).creditCents += toCents(entry.amount);
  }
  const creditOf = (planId: string, currency: string): number =>
    creditByPlan.get(planId)?.get(currency) ?? 0;
  const planById = new Map(snapshot.plans.map((p) => [p.id, p]));

  // --- Planes -------------------------------------------------------------
  const plans: StatementPlanLine[] = snapshot.plans.map((plan) => {
    const counts = countsTowardsBalance(plan.status);
    const budgetedCents = toCents(plan.billable);
    const paidMap = paidByPlan.get(plan.id) ?? new Map<string, number>();
    const paidCents = paidMap.get(plan.currency) ?? 0;
    const creditCents = creditOf(plan.id, plan.currency);
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
      creditMovements: fromCents(creditCents),
      balance: fromCents(
        (counts ? budgetedCents : 0) - paidCents - creditCents,
      ),
    };
  });

  // --- Saldo migrado (DX-262) -----------------------------------------------
  // Deuda traída del programa anterior: suma al saldo de su moneda; sus
  // abonos (revisión C1) la reducen como cualquier abono.
  const openingBalances = [...(snapshot.openingBalances ?? [])].sort(
    (a, b) =>
      a.asOfDate.localeCompare(b.asOfDate) ||
      a.currency.localeCompare(b.currency) ||
      a.id.localeCompare(b.id),
  );
  // Abonos vivos contra cada saldo migrado, en su moneda (revisión C1).
  const paidByOpening = new Map<string, number>();
  for (const p of snapshot.payments) {
    if (!isActive(p) || !p.openingBalanceId) continue;
    const key = `${p.openingBalanceId}\u0000${p.currency}`;
    paidByOpening.set(key, (paidByOpening.get(key) ?? 0) + toCents(p.amount));
  }
  const openingLines = openingBalances.map((o) => {
    acc(o.currency).openingCents += toCents(o.amount);
    const paidCents = paidByOpening.get(`${o.id}\u0000${o.currency}`) ?? 0;
    const pendingCents = Math.max(0, toCents(o.amount) - paidCents);
    acc(o.currency).openingPendingCents += pendingCents;
    return {
      ...o,
      paid: fromCents(paidCents),
      pending: fromCents(pendingCents),
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
    // DX-253: un traspaso recibido cubre cuotas como un abono; una
    // devolución deja de cubrirlas.
    const paidCents =
      (paidByPlan.get(paymentPlan.treatmentPlanId)?.get(paymentPlan.currency) ??
        0) + creditOf(paymentPlan.treatmentPlanId, paymentPlan.currency);
    const derived = deriveStatuses(
      buildTramos(paymentPlan),
      fromCents(paidCents),
      today,
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

  // --- Resumen ----------------------------------------------------------------
  const summary: StatementCurrencySummary[] = [...currencies.entries()]
    .filter(
      ([, a]) =>
        a.budgetedCents !== 0 ||
        a.openingCents !== 0 ||
        a.paidCents !== 0 ||
        a.creditCents !== 0 ||
        a.hasInstallments,
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, a]) => ({
      currency,
      budgeted: fromCents(a.budgetedCents),
      openingBalance: fromCents(a.openingCents),
      openingPending: fromCents(a.openingPendingCents),
      paid: fromCents(a.paidCents),
      creditMovements: fromCents(a.creditCents),
      balance: fromCents(
        a.budgetedCents + a.openingCents - a.paidCents - a.creditCents,
      ),
      overdueCount: a.overdueCount,
      overdueAmount: fromCents(a.overdueCents),
      nextInstallment: a.next,
    }));

  return { summary, plans, installments, openingBalances: openingLines };
}

export function computeAccountStatement(
  snapshot: StatementSnapshot,
  options: ComputeAccountStatementOptions,
): ComputedAccountStatement {
  const { summary, plans, installments, openingBalances } = computeBalances(
    snapshot,
    options.today,
  );

  // --- Movimientos ----------------------------------------------------------
  // DX-097: el día de cada abono es el de SU sede, no el día UTC.
  // DX-390: cuántas líneas tiene cada cobro dividido (todas las del paciente:
  // el filtro de fechas no parte un cobro, que lleva un solo día).
  const splitLines = new Map<string, number>();
  for (const p of snapshot.payments) {
    if (p.splitId)
      splitLines.set(p.splitId, (splitLines.get(p.splitId) ?? 0) + 1);
  }
  const movements: StatementMovement[] = snapshot.payments
    .map((p) => ({ p, paidOn: civilDateIn(p.paidAt, p.timeZone) }))
    .filter(({ paidOn }) =>
      inRange(paidOn, options.movementsFrom, options.movementsTo),
    )
    .map(({ p, paidOn }) => ({
      id: p.id,
      paidAt: p.paidAt,
      paidOn,
      amount: p.amount,
      currency: p.currency,
      method: p.method,
      paymentMethod: p.paymentMethod,
      reference: p.reference,
      externalInvoiceNumber: p.externalInvoiceNumber ?? null,
      splitId: p.splitId ?? null,
      splitLines: p.splitId ? (splitLines.get(p.splitId) ?? null) : null,
      location: p.location,
      treatmentPlanId: p.treatmentPlanId,
      openingBalanceId: p.openingBalanceId ?? null,
      createdById: p.createdById,
      canVoid:
        p.voidedAt === null &&
        options.voidActor !== undefined &&
        canVoidPayment(p, options.voidActor, options.today),
      voided: p.voidedAt !== null,
      voidedAt: p.voidedAt,
      voidedBy: p.voidedBy,
      voidReason: p.voidReason,
    }))
    .sort(
      (a, b) =>
        b.paidAt.getTime() - a.paidAt.getTime() || b.id.localeCompare(a.id),
    );

  return { summary, plans, movements, installments, openingBalances };
}
