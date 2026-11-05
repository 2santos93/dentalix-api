import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { CivilPeriod } from '../comparison-period';

/** Una sede viva de la clínica que quien consulta puede ver (DX-089). */
export interface UnallocatedLocation {
  id: string;
  name: string;
  isActive: boolean;
}

/**
 * Un abono vivo a un plan que se cobra, con su base ya convertida a la
 * moneda del plan y menos imputado que ella. Los importes, en CENTAVOS
 * enteros: `planCents` (la base), `allocatedCents` (la suma de sus
 * imputaciones vivas) y `unallocatedCents` (lo que queda a cuenta: base menos
 * imputado y menos lo que el plan ya devolvió o traspasó, DX-253; siempre > 0).
 */
export interface UnallocatedPaymentRow {
  paymentId: string;
  patientId: string;
  patientName: string;
  locationId: string;
  locationName: string;
  /** Zona de la sede del abono: su día civil se corta con ella. */
  timeZone: string;
  paidAt: Date;
  /** Importe del abono, en su moneda (`paymentCurrency`). */
  paymentAmount: number;
  paymentCurrency: string;
  planId: string;
  planCurrency: string;
  planCents: number;
  allocatedCents: number;
  unallocatedCents: number;
}

/** Suma, por moneda del plan, de TODOS los abonos del alcance. */
export interface UnallocatedSums {
  currency: string;
  count: number;
  allocatedCents: number;
  unallocatedCents: number;
}

export interface UnallocatedScope {
  locationIds: readonly string[];
}

export const UNALLOCATED_PAYMENTS_REPOSITORY = Symbol(
  'UNALLOCATED_PAYMENTS_REPOSITORY',
);

/** Todo el informe de un período y unas sedes, leído en UNA foto de la BD. */
export interface UnallocatedReport {
  rows: UnallocatedPaymentRow[];
  /** Filas de la lista completa (no solo `rows`). */
  total: number;
  /** Por moneda del plan, sobre todo el alcance. */
  totals: UnallocatedSums[];
  /**
   * Abonos del período en otra moneda que la del plan a los que todavía les
   * falta la tasa de su día: no tienen base, no se pueden imputar y no entran
   * en las cifras. (Uno en la moneda del plan sin base espera al barrido y no
   * necesita ninguna tasa: no se cuenta.)
   */
  withoutRateCount: number;
}

export interface UnallocatedPaymentsRepository {
  /** Sedes vivas de la clínica que el usuario ve, en orden de creación. */
  listLocations(allowed: AllowedLocations): Promise<UnallocatedLocation[]>;
  /** ¿Es una sede viva de la clínica en contexto? */
  locationInClinic(locationId: string): Promise<boolean>;
  /**
   * Los abonos con algo sin imputar (neto de lo ya devuelto o traspasado,
   * DX-253) cuyo día civil, en la zona de su sede, cae en el período, del más
   * reciente al más antiguo. Sin `page`, todos. Una sola transacción de
   * lectura repetible: filas, total y totales ven la misma foto.
   */
  report(
    period: CivilPeriod,
    scope: UnallocatedScope,
    page?: { skip: number; take: number },
  ): Promise<UnallocatedReport>;
}
