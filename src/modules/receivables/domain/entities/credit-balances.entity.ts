/*
 * Cartera › Saldo a favor (DX-430): qué pacientes tienen dinero a favor en cada
 * sede, para aplicarlo (traspaso) o devolverlo (DX-253). Sin datos clínicos:
 * solo nombre, importes y fechas.
 */

/** Lo que sobra en UN plan (`-balance` si es negativo), en la moneda del plan. */
export interface PlanCredit {
  planId: string;
  currency: string;
  /** Céntimos. */
  creditCents: number;
}

/** Un abono vivo que sirve para saber de dónde y desde cuándo viene el saldo de un plan. */
export interface OriginPayment {
  paidAt: Date;
  /** Sede donde se cobró. */
  locationId: string;
  /** Céntimos en la moneda del plan; `null` si aún no se puede contar (otra moneda sin base). */
  planCents: number | null;
}

/**
 * Hechos para atribuir el saldo de un plan a una sede y fecharlo (DX-430):
 * la sede del propio plan (aceptación, si no presentación), sus abonos vivos
 * por orden cronológico y, si no tiene propios (recibió el saldo por
 * traspaso), los de los planes de los que vino.
 */
export interface PlanCreditFacts {
  planLocationId: string | null;
  ownPayments: OriginPayment[];
  transferredPayments: OriginPayment[];
}

/** De dónde viene el saldo de un plan: la sede que lo tiene y el abono que lo originó. */
export interface PlanCreditOrigin {
  /** Sede a la que se atribuye; `null` si ni el plan ni sus abonos tienen. */
  locationId: string | null;
  /** El abono que lo originó (para su fecha y su sede); `null` si no hay abonos. */
  payment: OriginPayment | null;
}

/** Una fila de la lista: un paciente, UNA sede y UNA moneda (el mismo paciente puede salir en varias). */
export interface CreditBalanceRow {
  patient: { id: string; fullName: string };
  /** Sede donde está el dinero (la del plan o, sin ella, la del abono que lo originó); `null` = sin sede. */
  location: { id: string; name: string } | null;
  currency: string;
  amount: number;
  /** Día civil (YYYY-MM-DD, zona de la sede del abono) del abono que originó el saldo. */
  since: string | null;
  /** Días de calendario desde `since` hasta hoy en la sede; `null` sin `since`. */
  ageDays: number | null;
}

export interface CreditBalanceTotal {
  currency: string;
  patients: number;
  amount: number;
}
