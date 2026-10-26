export const EXPENSE_SUMMARY_REPOSITORY = Symbol('EXPENSE_SUMMARY_REPOSITORY');

export interface ExpenseSummaryQuery {
  /** Días civiles, ambos incluidos. */
  from: string;
  to: string;
  locationId?: string;
}

/** `month` = `AAAA-MM`; importes en céntimos. */
export interface SummaryIncomeRow {
  month: string;
  locationId: string;
  currency: string;
  cents: number;
}

export interface SummaryExpenseRow extends SummaryIncomeRow {
  category: string;
}

export interface ExpenseSummaryData {
  /** Nombre de cada sede de la clínica (incluidas las retiradas). */
  locationNames: Map<string, string>;
  income: SummaryIncomeRow[];
  expenses: SummaryExpenseRow[];
}

export interface ExpenseSummaryRepository {
  /**
   * Ingresos (abonos vivos, por el día civil de la sede) y gastos no
   * anulados (por fecha de factura) del rango, de las sedes visibles para el
   * usuario, en UNA foto de la base. Una sede pedida fuera de las visibles no
   * devuelve nada.
   */
  summarize(query: ExpenseSummaryQuery): Promise<ExpenseSummaryData>;
}
