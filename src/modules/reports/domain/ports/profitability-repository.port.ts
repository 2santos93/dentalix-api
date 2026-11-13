import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { CivilPeriod } from '../comparison-period';
import type {
  ExpensePaymentStatus,
  ExpenseSum,
  IncomeSum,
  ProfitabilityBasis,
  ProfitabilityLocation,
  ProfitabilitySide,
} from '../profitability';

export const PROFITABILITY_REPOSITORY = Symbol('PROFITABILITY_REPOSITORY');

export interface ProfitabilitySums {
  income: IncomeSum[];
  expenses: ExpenseSum[];
}

export interface ProfitabilityLinesQuery {
  period: CivilPeriod;
  basis: ProfitabilityBasis;
  side: ProfitabilitySide;
  currency: string;
  /** Solo gastos: la categoría (foto del nombre). */
  category?: string;
  /** Las sedes de la consulta (ya acotadas a las del usuario). */
  locations: readonly ProfitabilityLocation[];
  page: number;
  pageSize: number;
}

/** Una fila del detalle: nunca lleva datos del paciente. */
export interface ProfitabilityLine {
  id: string;
  /** Día civil (zona de la sede para abonos y procedimientos). */
  date: string;
  locationId: string;
  amountCents: number;
  /**
   * Abono: nº de recibo (o la referencia antigua `REC-…`). Procedimiento:
   * código y nombre del catálogo. Gasto: proveedor o, sin él, descripción.
   */
  concept: string | null;
  /** Solo gastos. */
  category: string | null;
  /** Caja: medio de pago (del catálogo de la clínica o el método). */
  method: string | null;
  /** Solo gastos en devengo: cuánto lleva pagado en vivo. */
  paymentStatus: ExpensePaymentStatus | null;
}

export interface ProfitabilityLinesPage {
  totalCents: number;
  count: number;
  lines: ProfitabilityLine[];
}

export interface ProfitabilityRepository {
  /**
   * Sedes vivas de la clínica que el usuario ve (DX-089), en orden de
   * creación, con su zona. Una sede sin zona y sin movimientos se omite; con
   * movimientos, 409 `LOCATION_TIMEZONE_REQUIRED`.
   */
  listLocations(allowed: AllowedLocations): Promise<ProfitabilityLocation[]>;
  /** Las sumas del período en la base pedida, en UNA foto de la base. */
  sums(
    period: CivilPeriod,
    basis: ProfitabilityBasis,
    locations: readonly ProfitabilityLocation[],
  ): Promise<ProfitabilitySums>;
  /** Las filas que forman una cifra, de la más reciente a la más antigua. */
  lines(query: ProfitabilityLinesQuery): Promise<ProfitabilityLinesPage>;
}
