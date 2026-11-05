/*
 * Cartera › Saldo a favor (DX-430): qué pacientes tienen dinero a favor en cada
 * sede, para aplicarlo (traspaso) o devolverlo (DX-253). Sin datos clínicos:
 * solo nombre, importes y fechas.
 */

/** Saldo a favor de un paciente en UNA moneda (la de los planes que lo originan). */
export interface PatientCreditCurrency {
  currency: string;
  /** Céntimos: Σ de lo que sobra de cada plan (`-balance` de los planes con saldo < 0). */
  creditCents: number;
  /** Los planes que lo originan (para fechar el abono más antiguo). */
  planIds: string[];
}

/** Una fila de la lista: un paciente y UNA moneda (el mismo paciente puede salir en varias). */
export interface CreditBalanceRow {
  patient: { id: string; fullName: string };
  /** Sede del paciente en la cartera (la de su deuda); `null` = sin sede. */
  location: { id: string; name: string } | null;
  currency: string;
  amount: number;
  /** Día civil (YYYY-MM-DD, zona de la sede) del abono más antiguo que origina el saldo. */
  since: string | null;
  /** Días de calendario desde `since` hasta hoy en la sede; `null` sin `since`. */
  ageDays: number | null;
}

export interface CreditBalanceTotal {
  currency: string;
  patients: number;
  amount: number;
}
