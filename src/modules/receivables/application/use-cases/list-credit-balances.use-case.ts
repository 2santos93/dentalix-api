import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import {
  CREDIT_BALANCES_REPOSITORY,
  type CreditBalancesRepository,
} from '../../domain/ports/credit-balances-repository.port';
import type {
  CreditBalanceRow,
  CreditBalanceTotal,
} from '../../domain/entities/credit-balances.entity';
import { ageInDays, fromCents } from '../../domain/aging';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { PlanBalanceCalculator } from '../../../payments/application/plan-balance-calculator';
import {
  CURRENCY_DIGITS_CATALOG,
  roundingDigitsLookup,
  type CurrencyDigitsCatalog,
} from '../../../../shared/money/currency-digits';
import { ledgerPlanBalanceInputs } from '../ledger-plan-balances';
import { computePatientCredit } from '../compute-patient-credit';
import { originOfPlanCredit } from '../credit-origin';
import { isPlanBillable } from '../../../treatment-plans/domain/plan-status-machine';
import { toCents } from '../../../../shared/money/money';
import type { PlanCreditFacts } from '../../domain/entities/credit-balances.entity';
import type { PatientLedger } from '../../domain/entities/receivables.entity';
import {
  RECEIVABLES_CLOCK,
  UNKNOWN_LOCATION_MESSAGE,
  type ReceivablesClock,
} from './get-receivables-aging.use-case';

export const CREDIT_BALANCES_DEFAULT_PAGE_SIZE = 20;
export const CREDIT_BALANCES_MAX_PAGE_SIZE = 100;

export interface CreditBalancesInput {
  /** Sede del paciente en la cartera; sin ella, las sedes permitidas al miembro. */
  locationId?: string;
  /** Solo esta moneda (ISO 4217). */
  currency?: string;
  page?: number;
  pageSize?: number;
}

export interface CreditBalancesPage {
  /** «Hoy» (YYYY-MM-DD) en la zona de la sede del alcance. */
  asOf: string;
  scope: { location: { id: string; name: string } | null };
  items: CreditBalanceRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Por moneda, sobre TODAS las filas (no solo la página). */
  totals: CreditBalanceTotal[];
  /** DX-472-bis: abonos en otra moneda sin tasa: el saldo a favor puede ser mayor. */
  paymentsWithoutRateCount: number;
  rateProviderTimedOut: boolean;
}

interface ScopedRow {
  patientId: string;
  /** Sede a la que se atribuye este saldo (la de sus planes); `null` = sin sede. */
  locationId: string | null;
  currency: string;
  cents: number;
  /** El abono más antiguo (entre los orígenes de los planes de la fila) y su sede. */
  since: { paidAt: Date; locationId: string } | null;
}

function wholeOrDefault(
  value: number | undefined,
  fallback: number,
  min: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

/** Moneda; luego más importe primero; luego paciente y sede (orden total y estable). */
function byCurrencyThenAmount(a: ScopedRow, b: ScopedRow): number {
  return (
    a.currency.localeCompare(b.currency) ||
    b.cents - a.cents ||
    a.patientId.localeCompare(b.patientId) ||
    (a.locationId ?? '').localeCompare(b.locationId ?? '')
  );
}

/**
 * Saldo a favor por paciente, sede y moneda (DX-430), la segunda mitad de
 * DX-253: a quién le debe dinero la clínica y dónde está ese dinero, para
 * aplicárselo a un plan o devolvérselo. Lee el resumen de la cartera
 * (`patient_ledgers`) de quienes pueden tenerlo, calcula cada saldo por plan
 * con el MISMO núcleo que el estado de cuenta (`computeBalances`, ver
 * `computePatientCredit`: ninguna fórmula propia) y lo atribuye a la sede de
 * su plan o, sin ella, a la del abono que lo originó (`originOfPlanCredit`).
 * Un paciente con saldo en dos sedes sale en dos filas; la suma de sus filas
 * por moneda es la del estado de cuenta. Filtra, ordena y pagina en memoria
 * (los totales necesitan todas las filas), como la cartera por antigüedad.
 */
@Injectable()
export class ListCreditBalancesUseCase {
  constructor(
    @Inject(CREDIT_BALANCES_REPOSITORY)
    private readonly repo: CreditBalancesRepository,
    @Inject(RECEIVABLES_CLOCK)
    private readonly now: ReceivablesClock,
    private readonly planBalance: PlanBalanceCalculator,
    @Optional()
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly currencyDigits?: CurrencyDigitsCatalog,
  ) {}

  async execute(input: CreditBalancesInput): Promise<CreditBalancesPage> {
    const location = input.locationId
      ? await this.repo.findLocation(input.locationId)
      : null;
    if (input.locationId && !location) {
      throw new BadRequestException(UNKNOWN_LOCATION_MESSAGE);
    }
    const [ledgers, zoneOf, locationNames] = await Promise.all([
      this.repo.loadCreditLedgers(),
      this.repo.locationTimeZones(),
      this.repo.locationNames(),
    ]);
    // DX-472-bis: lo abonado en otra moneda, convertido como en `/balance`.
    const [planBalances, roundingDigitsOf] = await Promise.all([
      this.planBalance.computeMany(ledgerPlanBalanceInputs(ledgers, zoneOf)),
      roundingDigitsLookup(
        this.currencyDigits,
        ledgers.flatMap((l) => l.plans.map((p) => p.currency)),
      ),
    ]);
    const now = this.now();

    // 1. El saldo de cada plan, con el mismo cálculo del estado de cuenta.
    const planCredits = ledgers.flatMap((ledger) =>
      computePatientCredit(ledger, { now, planBalances, roundingDigitsOf })
        .filter((c) => !input.currency || c.currency === input.currency)
        .map((credit) => ({
          ...credit,
          patientId: ledger.patientId,
          billableCents: billableOf(ledger, credit.planId),
        })),
    );
    // 2. De qué sede y de qué abono viene cada uno.
    // Los planes con abonos sin contar (aviso de tasas) también se atribuyen a
    // una sede, para que el aviso respete el mismo filtro que las filas.
    const flagged = [...planBalances.entries()].filter(
      ([, known]) =>
        known.paymentsWithoutRate.length > 0 || known.rateProviderTimedOut,
    );
    const facts = await this.repo.planCreditFacts([
      ...new Set([
        ...planCredits.map((c) => c.planId),
        ...flagged.map(([planId]) => planId),
      ]),
    ]);
    const ledgerOfPlan = new Map(
      ledgers.flatMap((l) => l.plans.map((p) => [p.id, l] as const)),
    );
    const emptyFacts: PlanCreditFacts = {
      planLocationId: null,
      ownPayments: [],
      transferredPayments: [],
    };
    const grouped = new Map<string, ScopedRow>();
    for (const credit of planCredits) {
      const origin = originOfPlanCredit(
        facts.get(credit.planId) ?? emptyFacts,
        credit.billableCents,
      );
      const key = `${credit.patientId}|${origin.locationId ?? ''}|${credit.currency}`;
      const row = grouped.get(key) ?? {
        patientId: credit.patientId,
        locationId: origin.locationId,
        currency: credit.currency,
        cents: 0,
        since: null,
      };
      row.cents += credit.creditCents;
      if (
        origin.payment &&
        (row.since === null ||
          origin.payment.paidAt.getTime() < row.since.paidAt.getTime())
      ) {
        row.since = {
          paidAt: origin.payment.paidAt,
          locationId: origin.payment.locationId,
        };
      }
      grouped.set(key, row);
    }

    // 3. Solo las sedes pedidas o permitidas al miembro (DX-089).
    const allowed = this.repo.allowedLocationIds();
    const visible = (locationId: string | null): boolean =>
      location
        ? locationId === location.id
        : allowed === undefined ||
          (locationId !== null && allowed.includes(locationId));
    const rows = [...grouped.values()]
      .filter((r) => visible(r.locationId))
      .sort(byCurrencyThenAmount);

    const page = wholeOrDefault(input.page, 1, 1);
    const pageSize = Math.min(
      wholeOrDefault(input.pageSize, CREDIT_BALANCES_DEFAULT_PAGE_SIZE, 1),
      CREDIT_BALANCES_MAX_PAGE_SIZE,
    );
    const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

    // El aviso de tasas cuenta solo los planes de las sedes que se ven.
    let withoutRate = 0;
    let timedOut = false;
    for (const [planId, known] of flagged) {
      if (input.currency && known.planCurrency !== input.currency) continue;
      const ledger = ledgerOfPlan.get(planId);
      const sede = originOfPlanCredit(
        facts.get(planId) ?? emptyFacts,
        ledger ? billableOf(ledger, planId) : 0,
      ).locationId;
      if (!visible(sede)) continue;
      withoutRate += known.paymentsWithoutRate.length;
      timedOut ||= known.rateProviderTimedOut;
    }

    return {
      asOf: civilDateIn(now, location?.timeZone ?? zoneOf(null)),
      scope: {
        location: location ? { id: location.id, name: location.name } : null,
      },
      items: await this.withDetails(pageRows, { now, zoneOf, locationNames }),
      total: rows.length,
      page,
      pageSize,
      totals: totalsOf(rows),
      paymentsWithoutRateCount: withoutRate,
      rateProviderTimedOut: timedOut,
    };
  }

  private async withDetails(
    rows: ScopedRow[],
    ctx: {
      now: Date;
      zoneOf: (locationId: string | null) => string;
      locationNames: Map<string, string>;
    },
  ): Promise<CreditBalanceRow[]> {
    if (rows.length === 0) return [];
    const names = await this.repo.patientNames([
      ...new Set(rows.map((r) => r.patientId)),
    ]);
    return rows.flatMap((row) => {
      const fullName = names.get(row.patientId);
      // Retirado entre las dos lecturas: no se muestra a medias.
      if (fullName === undefined) return [];
      // Fecha en el día civil de la sede DEL ABONO (como el estado de cuenta,
      // DX-097); los días hasta hoy, contados en la sede de la fila.
      const since = row.since
        ? civilDateIn(row.since.paidAt, ctx.zoneOf(row.since.locationId))
        : null;
      const today = civilDateIn(ctx.now, ctx.zoneOf(row.locationId));
      return [
        {
          patient: { id: row.patientId, fullName },
          location:
            row.locationId && ctx.locationNames.has(row.locationId)
              ? {
                  id: row.locationId,
                  name: ctx.locationNames.get(row.locationId)!,
                }
              : null,
          currency: row.currency,
          amount: fromCents(row.cents),
          since,
          ageDays: since ? Math.max(0, ageInDays(since, today)) : null,
        },
      ];
    });
  }
}

/** Lo facturable que cuenta del plan (0 si está cancelado o rechazado). */
function billableOf(ledger: PatientLedger, planId: string): number {
  const plan = ledger.plans.find((p) => p.id === planId);
  return plan && isPlanBillable(plan.status) ? toCents(plan.billable) : 0;
}

function totalsOf(rows: ScopedRow[]): CreditBalanceTotal[] {
  const byCurrency = new Map<
    string,
    { patients: Set<string>; cents: number }
  >();
  for (const row of rows) {
    const acc = byCurrency.get(row.currency) ?? {
      patients: new Set<string>(),
      cents: 0,
    };
    acc.patients.add(row.patientId);
    acc.cents += row.cents;
    byCurrency.set(row.currency, acc);
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, acc]) => ({
      currency,
      patients: acc.patients.size,
      amount: fromCents(acc.cents),
    }));
}
