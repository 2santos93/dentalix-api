import { computeBalances } from '../../account-statement/application/compute-account-statement';
import { civilDateResolver } from '../../../shared/time/civil-day';
import {
  addToBuckets,
  ageInDays,
  bucketOf,
  emptyBuckets,
  fromCents,
  toCents,
  type AgedAmount,
} from '../domain/aging';
import type {
  PatientAging,
  PatientAgingCurrency,
  PatientLedger,
} from '../domain/entities/receivables.entity';

export interface ComputePatientAgingOptions {
  /** "Ahora" (inyectado, nunca el reloj). */
  now: Date;
  /** Zona IANA de la sede de la deuda: decide qué día es «hoy». */
  timeZone: string;
}

// Un resolvedor por zona para todo el proceso: la cartera fecha miles de
// planes por petición y `Intl` es lo caro (ver civilDateResolver).
const resolvers = new Map<string, (instant: Date) => string>();
function civilDayIn(timeZone: string): (instant: Date) => string {
  let resolve = resolvers.get(timeZone);
  if (!resolve) {
    resolve = civilDateResolver(timeZone);
    resolvers.set(timeZone, resolve);
  }
  return resolve;
}

interface DebtLine extends AgedAmount {
  cents: number;
  approximate: boolean;
}

interface CurrencyAcc {
  lines: DebtLine[];
  creditCents: number;
}

/*
 * CRITERIOS (DX-145, documentados también en el informe):
 *
 * - El SALDO es el del estado de cuenta: `computeBalances` (el mismo núcleo que
 *   GET /patients/:id/account-statement), por plan, por moneda y sin convertir.
 *   Aquí solo se REPARTE en líneas fechadas; no hay un segundo cálculo.
 * - Plan con saldo > 0:
 *   - sus cuotas (plan de pagos en la moneda del plan), con lo que les falta
 *     tras el reparto voraz de los abonos, envejecen desde su vencimiento; una
 *     cuota que aún no vence va a «por vencer». Si el calendario suma más que
 *     el saldo del plan, solo se envejece el saldo, desde la cuota más antigua;
 *   - lo que queda sin calendario envejece desde `agingFrom` (aceptación,
 *     presentación o creación del plan) y se marca aproximado.
 * - Plan con saldo < 0 (pagado de más, o cancelado/rechazado con abonos) y
 *   abonos hechos en otra moneda que la del plan: saldo a favor de esa moneda.
 *   Va aparte, nunca se resta de los tramos; por eso `balance = debt − credit`.
 * - Saldo migrado (DX-262): una línea por saldo, desde su fecha de corte
 *   (aproximada si el archivo no la traía y se usó la de la importación).
 * - «Hoy» y el día de `agingFrom` son días civiles de la zona de la sede (DX-097).
 *   El vencimiento de una cuota es su día UTC, como en deriveStatuses.
 */
export function computePatientAging(
  ledger: PatientLedger,
  options: ComputePatientAgingOptions,
): PatientAging {
  const balances = computeBalances(
    {
      plans: ledger.plans,
      payments: ledger.paid.map((p) => ({ ...p, voidedAt: null })),
      paymentPlans: ledger.paymentPlans,
      openingBalances: ledger.openings,
    },
    options.now,
  );
  const dayOf = civilDayIn(options.timeZone);
  const today = dayOf(options.now);
  const agingFromOf = new Map(ledger.plans.map((p) => [p.id, p.agingFrom]));

  const byCurrency = new Map<string, CurrencyAcc>();
  const acc = (currency: string): CurrencyAcc => {
    const existing = byCurrency.get(currency);
    if (existing) return existing;
    const created: CurrencyAcc = { lines: [], creditCents: 0 };
    byCurrency.set(currency, created);
    return created;
  };

  for (const line of balances.plans) {
    for (const other of line.paidOtherCurrencies) {
      acc(other.currency).creditCents += toCents(other.amount);
    }
    const balanceCents = toCents(line.balance);
    if (balanceCents < 0) {
      acc(line.currency).creditCents -= balanceCents;
      continue;
    }
    if (balanceCents === 0) continue;

    const target = acc(line.currency);
    let remaining = balanceCents;
    // Ya vienen por vencimiento (computeBalances las ordena).
    const dues = balances.installments.filter(
      (i) => i.treatmentPlanId === line.id && i.currency === line.currency,
    );
    for (const inst of dues) {
      const cents = Math.min(toCents(inst.outstanding), remaining);
      if (cents <= 0) continue;
      const dueDay = inst.dueDate.toISOString().slice(0, 10);
      target.lines.push({
        cents,
        ageDays: ageInDays(dueDay, today),
        due: dueDay < today,
        approximate: false,
      });
      remaining -= cents;
    }
    if (remaining > 0) {
      const from = dayOf(agingFromOf.get(line.id) ?? line.createdAt);
      target.lines.push({
        cents: remaining,
        ageDays: Math.max(0, ageInDays(from, today)),
        due: true,
        approximate: true,
      });
    }
  }

  // Saldo migrado (DX-262): exigible desde su fecha de corte; aproximado si
  // es la de la importación. Nada se le imputa todavía (DX-051).
  for (const o of balances.openingBalances) {
    const cents = toCents(o.amount);
    if (cents <= 0) continue;
    acc(o.currency).lines.push({
      cents,
      ageDays: Math.max(0, ageInDays(o.asOfDate, today)),
      due: true,
      approximate: o.asOfDateApproximate,
    });
  }

  const nextOf = new Map(
    balances.summary.map((s) => [s.currency, s.nextInstallment]),
  );
  const balanceOf = new Map(
    balances.summary.map((s) => [s.currency, s.balance]),
  );

  const currencies: PatientAgingCurrency[] = [...byCurrency.entries()]
    .map(([currency, a]) => {
      const buckets = emptyBuckets();
      let debtCents = 0;
      let oldest: number | null = null;
      let approximate = false;
      for (const l of a.lines) {
        addToBuckets(buckets, bucketOf(l), fromCents(l.cents));
        debtCents += l.cents;
        approximate ||= l.approximate;
        if (l.due && (oldest === null || l.ageDays > oldest)) {
          oldest = l.ageDays;
        }
      }
      const next = nextOf.get(currency) ?? null;
      return {
        currency,
        balance:
          balanceOf.get(currency) ?? fromCents(debtCents - a.creditCents),
        debt: fromCents(debtCents),
        credit: fromCents(a.creditCents),
        buckets,
        oldestAgeDays: oldest,
        ageApproximate: approximate,
        nextInstallment: next
          ? { dueDate: next.dueDate, amount: next.amount }
          : null,
      };
    })
    .filter((c) => c.debt > 0 || c.credit > 0)
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return summarizeCurrencies(currencies);
}

/** Antigüedad y marca aproximada de la fila a partir de sus monedas. */
export function summarizeCurrencies(
  currencies: PatientAgingCurrency[],
): PatientAging {
  let oldest: number | null = null;
  for (const c of currencies) {
    if (
      c.oldestAgeDays !== null &&
      (oldest === null || c.oldestAgeDays > oldest)
    ) {
      oldest = c.oldestAgeDays;
    }
  }
  return {
    currencies,
    oldestAgeDays: oldest,
    ageApproximate: currencies.some((c) => c.debt > 0 && c.ageApproximate),
  };
}
