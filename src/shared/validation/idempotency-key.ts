/**
 * DX-463: el 400 de una cabecera `Idempotency-Key` que no es un UUID. Un solo
 * texto, en español, para todo endpoint que la valide (cobros, gastos,
 * atención sin cita, saldo a favor, entrega de indicaciones): la pantalla no
 * tiene que traducir ni distinguir el mensaje de cada módulo.
 */
export const IDEMPOTENCY_KEY_INVALID_MESSAGE =
  'La clave de idempotencia (cabecera Idempotency-Key) debe ser un UUID: genera una nueva y vuelve a intentarlo.';
