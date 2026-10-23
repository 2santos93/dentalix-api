/** Reloj inyectable: «hoy» de la sede y la caducidad de las URL dependen de él. */
export type ExpenseClock = () => Date;
export const EXPENSE_CLOCK = Symbol('EXPENSE_CLOCK');

/** Vida de la URL firmada del soporte (s). Los e2e la acortan para probar la caducidad. */
export const EXPENSE_RECEIPT_URL_TTL = Symbol('EXPENSE_RECEIPT_URL_TTL');
/** Vida del POST prefirmado de la subida directa (s). */
export const EXPENSE_RECEIPT_UPLOAD_TTL = Symbol('EXPENSE_RECEIPT_UPLOAD_TTL');
