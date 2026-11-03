import {
  computeBalances,
  type PlanBalances,
  type RoundingDigitsOf,
} from '../../account-statement/application/compute-account-statement';
import { roundToDigits } from '../../../shared/money/line-rounding';
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
  /**
   * DX-472-bis: el saldo de los planes con abonos en otra moneda, de
   * `PlanBalanceCalculator` (`ledgerPlanBalanceInputs`): lo abonado cuenta
   * convertido, como en el estado de cuenta. Sin él, sin convertir.
   */
  planBalances?: PlanBalances;
  /**
   * B4 (DX-472-bis): decimales de redondeo de cada moneda: un residuo de la
   * conversión que la moneda no tiene (¥0,13) no es deuda. Sin ellos, 2.
   */
  roundingDigitsOf?: RoundingDigitsOf;
  /**
   * DX-472-bis (revisión B2): con la cartera filtrada por moneda, los avisos
   * solo cuentan los planes de esa moneda.
   */
  flagsCurrency?: string;
}

/** DX-472-bis: lo que la fila no pudo sumar por falta de tasa. */
export interface AgingRateFlags {
  paymentsWithoutRateCount: number;
  rateProviderTimedOut: boolean;
}

const NO_RATE_FLAGS: AgingRateFlags = {
  paymentsWithoutRateCount: 0,
  rateProviderTimedOut: false,
};

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
  /** DX-472-ter: los avisos de los planes de esta moneda. */
  flags: AgingRateFlags;
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
 * - Plan con saldo < 0 (pagado de más, o cancelado/rechazado con abonos):
 *   saldo a favor de su moneda. Va aparte, nunca se resta de los tramos; por
 *   eso `balance = debt − credit`.
 * - DX-472-bis: lo abonado en otra moneda cuenta convertido a la del plan
 *   (`planBalances`, la misma cuenta que el estado de cuenta). Lo que no se
 *   pudo convertir no suma ni va a saldo a favor: la fila lo avisa
 *   (`paymentsWithoutRateCount`). Si el proveedor no respondió, la deuda de
 *   ese plan no se da por vencida (va a «por vencer»), como sus cuotas en el
 *   estado de cuenta. Una fila anterior a DX-472-bis (sin `planBalances` del
 *   plan) sigue como antes: lo de otra moneda, a favor en esa moneda.
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
    options.planBalances,
    options.roundingDigitsOf,
  );
  const dayOf = civilDayIn(options.timeZone);
  const today = dayOf(options.now);
  const agingFromOf = new Map(ledger.plans.map((p) => [p.id, p.agingFrom]));

  const byCurrency = new Map<string, CurrencyAcc>();
  const acc = (currency: string): CurrencyAcc => {
    const existing = byCurrency.get(currency);
    if (existing) return existing;
    const created: CurrencyAcc = {
      lines: [],
      creditCents: 0,
      flags: { ...NO_RATE_FLAGS },
    };
    byCurrency.set(currency, created);
    return created;
  };

  const flags = { ...NO_RATE_FLAGS };
  for (const line of balances.plans) {
    const known = options.planBalances?.get(line.id);
    if (known) {
      if (!options.flagsCurrency || options.flagsCurrency === line.currency) {
        flags.paymentsWithoutRateCount += known.paymentsWithoutRate.length;
        flags.rateProviderTimedOut ||= known.rateProviderTimedOut;
      }
      // DX-472-ter: y en la moneda del plan, para la línea del CSV.
      const own = acc(line.currency).flags;
      own.paymentsWithoutRateCount += known.paymentsWithoutRate.length;
      own.rateProviderTimedOut ||= known.rateProviderTimedOut;
    } else {
      for (const other of line.paidOtherCurrencies) {
        acc(other.currency).creditCents += toCents(other.amount);
      }
    }
    // Sin respuesta del proveedor, el saldo está incompleto: nada vencido.
    const mayBeDue = !known?.rateProviderTimedOut;
    const balanceCents = toCents(line.balance);
    if (balanceCents < 0) {
      acc(line.currency).creditCents -= balanceCents;
      continue;
    }
    if (balanceCents === 0) continue;
    // B4: lo que la moneda no tiene (¥0,13 tras convertir) no es deuda.
    if (
      roundToDigits(
        fromCents(balanceCents),
        options.roundingDigitsOf?.(line.currency) ?? 2,
      ) === 0
    ) {
      continue;
    }

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
        due: mayBeDue && dueDay < today,
        approximate: false,
      });
      remaining -= cents;
    }
    if (remaining > 0) {
      const from = dayOf(agingFromOf.get(line.id) ?? line.createdAt);
      target.lines.push({
        cents: remaining,
        ageDays: Math.max(0, ageInDays(from, today)),
        due: mayBeDue,
        approximate: true,
      });
    }
  }

  // Saldo migrado (DX-262): lo que queda pendiente tras sus abonos, exigible
  // desde su fecha de corte; aproximado si es la de la importación.
  for (const o of balances.openingBalances) {
    const cents = toCents(o.pending);
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
  // DX-472-bis: el saldo convertido (el que pinta el estado de cuenta); sin
  // `planBalances` es el mismo que `balance`.
  const balanceOf = new Map(
    balances.summary.map((s) => [s.currency, s.convertedBalance]),
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
        ...a.flags,
      };
    })
    .filter((c) => c.debt > 0 || c.credit > 0)
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return summarizeCurrencies(currencies, flags);
}

/** Antigüedad y marca aproximada de la fila a partir de sus monedas. */
export function summarizeCurrencies(
  currencies: PatientAgingCurrency[],
  flags: AgingRateFlags = NO_RATE_FLAGS,
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
    paymentsWithoutRateCount: flags.paymentsWithoutRateCount,
    rateProviderTimedOut: flags.rateProviderTimedOut,
  };
}
