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
  locationId: string | null;
  currency: string;
  cents: number;
  planIds: string[];
}

function wholeOrDefault(
  value: number | undefined,
  fallback: number,
  min: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

/** Moneda; luego más importe primero; luego el paciente (orden total y estable). */
function byCurrencyThenAmount(a: ScopedRow, b: ScopedRow): number {
  return (
    a.currency.localeCompare(b.currency) ||
    b.cents - a.cents ||
    a.patientId.localeCompare(b.patientId)
  );
}

/**
 * Saldo a favor por paciente (DX-430), la segunda mitad de DX-253: a quién
 * le debe dinero la clínica, para aplicárselo a un plan o devolvérselo. Lee el
 * resumen de la cartera (`patient_ledgers`) de quienes pueden tenerlo, calcula
 * cada saldo con el MISMO núcleo que el estado de cuenta (`computeBalances`, ver
 * `computePatientCredit`: ninguna fórmula propia) y solo pide nombres y fechas
 * de la página. Filtra, ordena y pagina en memoria (los totales necesitan todas
 * las filas), como la cartera por antigüedad.
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
      this.repo.loadCreditLedgers({ locationId: location?.id }),
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

    const rows: ScopedRow[] = [];
    for (const ledger of ledgers) {
      for (const credit of computePatientCredit(ledger, {
        now,
        planBalances,
        roundingDigitsOf,
      })) {
        if (input.currency && credit.currency !== input.currency) continue;
        rows.push({
          patientId: ledger.patientId,
          locationId: ledger.locationId,
          currency: credit.currency,
          cents: credit.creditCents,
          planIds: credit.planIds,
        });
      }
    }
    rows.sort(byCurrencyThenAmount);

    const page = wholeOrDefault(input.page, 1, 1);
    const pageSize = Math.min(
      wholeOrDefault(input.pageSize, CREDIT_BALANCES_DEFAULT_PAGE_SIZE, 1),
      CREDIT_BALANCES_MAX_PAGE_SIZE,
    );
    const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

    let withoutRate = 0;
    let timedOut = false;
    for (const known of planBalances.values()) {
      if (input.currency && known.planCurrency !== input.currency) continue;
      withoutRate += known.paymentsWithoutRate.length;
      timedOut ||= known.rateProviderTimedOut;
    }

    return {
      asOf: civilDateIn(now, location?.timeZone ?? zoneOf(null)),
      scope: {
        location: location ? { id: location.id, name: location.name } : null,
      },
      items: await this.withDetails(pageRows, {
        now,
        zoneOf,
        locationNames,
      }),
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
    const [names, oldest] = await Promise.all([
      this.repo.patientNames([...new Set(rows.map((r) => r.patientId))]),
      this.repo.oldestCreditPayments([
        ...new Set(rows.flatMap((r) => r.planIds)),
      ]),
    ]);
    return rows.flatMap((row) => {
      const fullName = names.get(row.patientId);
      // Retirado entre las dos lecturas: no se muestra a medias.
      if (fullName === undefined) return [];
      const zone = ctx.zoneOf(row.locationId);
      let first: Date | null = null;
      for (const planId of row.planIds) {
        const at = oldest.get(planId);
        if (at && (first === null || at.getTime() < first.getTime())) {
          first = at;
        }
      }
      const since = first ? civilDateIn(first, zone) : null;
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
          ageDays: since
            ? Math.max(0, ageInDays(since, civilDateIn(ctx.now, zone)))
            : null,
        },
      ];
    });
  }
}

function totalsOf(rows: ScopedRow[]): CreditBalanceTotal[] {
  const byCurrency = new Map<string, { patients: number; cents: number }>();
  for (const row of rows) {
    const acc = byCurrency.get(row.currency) ?? { patients: 0, cents: 0 };
    acc.patients += 1;
    acc.cents += row.cents;
    byCurrency.set(row.currency, acc);
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, acc]) => ({
      currency,
      patients: acc.patients,
      amount: fromCents(acc.cents),
    }));
}
