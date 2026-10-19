/** Reloj inyectable de la caja por turno: «hoy» en la sede decide la fecha de bloqueo sugerida. */
export type CashSessionsClock = () => Date;
export const CASH_SESSIONS_CLOCK = Symbol('CASH_SESSIONS_CLOCK');
