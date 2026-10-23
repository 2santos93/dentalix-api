import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  civilDaysInclusive,
  parseCivilDate,
} from '../../../../shared/time/civil-day';
import { fromCents } from '../../domain/expense-rules';
import {
  EXPENSE_SUMMARY_REPOSITORY,
  type ExpenseSummaryData,
  type ExpenseSummaryRepository,
} from '../../domain/ports/expense-summary-repository.port';

/** Un año (bisiesto incluido), como el resto de informes por periodo. */
export const EXPENSE_SUMMARY_MAX_DAYS = 366;
export const SUMMARY_PERIOD_INVALID_MESSAGE =
  'El periodo no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const SUMMARY_PERIOD_TOO_LONG_MESSAGE = `El periodo admite como mucho ${EXPENSE_SUMMARY_MAX_DAYS} días.`;

export interface ExpenseSummaryInput {
  from?: string;
  to?: string;
  locationId?: string;
}

export interface ExpenseSummaryCategoryView {
  category: string;
  amount: number;
}

/** Un mes de una sede en una moneda: nunca se mezclan monedas. */
export interface ExpenseSummaryRowView {
  /** `AAAA-MM`. */
  month: string;
  locationId: string;
  locationName: string;
  currency: string;
  income: number;
  /** Mayor primero. */
  categories: ExpenseSummaryCategoryView[];
  expensesTotal: number;
  /** Ingresos − gastos (puede ser negativo). */
  net: number;
}

export interface ExpenseSummaryView {
  from: string;
  to: string;
  rows: ExpenseSummaryRowView[];
}

interface Bucket {
  month: string;
  locationId: string;
  currency: string;
  incomeCents: number;
  categories: Map<string, number>;
}

function assemble(
  data: ExpenseSummaryData,
): Omit<ExpenseSummaryView, 'from' | 'to'> {
  const buckets = new Map<string, Bucket>();
  const bucketOf = (r: {
    month: string;
    locationId: string;
    currency: string;
  }) => {
    const key = `${r.month}|${r.locationId}|${r.currency}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        month: r.month,
        locationId: r.locationId,
        currency: r.currency,
        incomeCents: 0,
        categories: new Map(),
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  for (const r of data.income) bucketOf(r).incomeCents += r.cents;
  for (const r of data.expenses) {
    const { categories } = bucketOf(r);
    categories.set(r.category, (categories.get(r.category) ?? 0) + r.cents);
  }
  const nameOf = (id: string) => data.locationNames.get(id) ?? '';
  const rows = [...buckets.values()].map((b): ExpenseSummaryRowView => {
    const categories = [...b.categories]
      .sort(([a, x], [c, y]) => y - x || a.localeCompare(c, 'es'))
      .map(([category, cents]) => ({ category, amount: fromCents(cents) }));
    const expensesCents = [...b.categories.values()].reduce((s, c) => s + c, 0);
    return {
      month: b.month,
      locationId: b.locationId,
      locationName: nameOf(b.locationId),
      currency: b.currency,
      income: fromCents(b.incomeCents),
      categories,
      expensesTotal: fromCents(expensesCents),
      net: fromCents(b.incomeCents - expensesCents),
    };
  });
  rows.sort(
    (a, b) =>
      a.month.localeCompare(b.month) ||
      a.locationName.localeCompare(b.locationName, 'es') ||
      a.currency.localeCompare(b.currency),
  );
  return { rows };
}

/**
 * Resumen mensual «ingresos − gastos» por sede y moneda (DX-274, solo ADMIN).
 * Gastos por fecha de factura (devengado) e ingresos por el día civil del
 * abono en su sede (R9); sin convertir monedas.
 */
@Injectable()
export class GetExpenseSummaryUseCase {
  constructor(
    @Inject(EXPENSE_SUMMARY_REPOSITORY)
    private readonly repo: ExpenseSummaryRepository,
  ) {}

  async execute(input: ExpenseSummaryInput): Promise<ExpenseSummaryView> {
    const from = parseCivilDate(input.from ?? '');
    const to = parseCivilDate(input.to ?? '');
    if (!from || !to || civilDaysInclusive(from, to) < 1) {
      throw new BadRequestException(SUMMARY_PERIOD_INVALID_MESSAGE);
    }
    if (civilDaysInclusive(from, to) > EXPENSE_SUMMARY_MAX_DAYS) {
      throw new BadRequestException(SUMMARY_PERIOD_TOO_LONG_MESSAGE);
    }
    const data = await this.repo.summarize({
      from,
      to,
      locationId: input.locationId,
    });
    return { from, to, ...assemble(data) };
  }
}
