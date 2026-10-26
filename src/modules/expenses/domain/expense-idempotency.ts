import { createHash } from 'node:crypto';

/**
 * Idempotencia de `POST /expenses` y `POST /expenses/:id/payments` (DX-274),
 * con el contrato de los abonos (DX-109): la cabecera `Idempotency-Key` (UUID)
 * y la huella de la petición se guardan con la fila; repetir la MISMA
 * petición devuelve la original y otra distinta con la misma clave es un 422.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** La clave recortada, `undefined` si viene vacía, o `null` si no es un UUID. */
export function parseIdempotencyKey(
  raw: string | undefined,
): string | undefined | null {
  const key = raw?.trim();
  if (!key) return undefined;
  return UUID_RE.test(key) ? key.toLowerCase() : null;
}

const text = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim() : (value ?? null);

const money = (value: unknown): unknown =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(2)
    : (value ?? null);

/** Espacios colapsados (categoría, proveedor). */
const spaced = (value: unknown): unknown =>
  typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ')
    : (value ?? null);

/** Texto opcional: vacío equivale a ausente. */
const optionalText = (value: unknown): unknown => {
  const normalized = text(value);
  return normalized === '' ? null : normalized;
};

const currencyCode = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : (value ?? null);

const lowerUuid = (value: unknown): string | null =>
  typeof value === 'string' ? value.toLowerCase() : null;

function sha(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export interface PaymentRequestShape {
  amount: unknown;
  method: unknown;
  paidOn?: unknown;
  fromCashSession?: unknown;
}

/** El pago, normalizado; «desde la caja» solo cuenta si es `true`. */
function paymentParts(input: PaymentRequestShape): unknown[] {
  const parts = [money(input.amount), input.method ?? null, text(input.paidOn)];
  return input.fromCashSession === true ? [...parts, 'FROM_CASH'] : parts;
}

/**
 * Huella de un pago: gasto de la ruta + importe a 2 decimales + medio + día
 * (+ «desde la caja»).
 */
export function expensePaymentFingerprint(
  expenseId: string,
  input: PaymentRequestShape,
): string {
  return sha([expenseId.toLowerCase(), ...paymentParts(input)]);
}

export interface ExpenseRequestShape {
  locationId?: unknown;
  category: unknown;
  supplier?: unknown;
  description?: unknown;
  amount: unknown;
  currency: unknown;
  invoiceDate: unknown;
  dueDate?: unknown;
  payment?: PaymentRequestShape | null;
  attachmentUploadId?: unknown;
}

/** Huella de un alta de gasto: el cuerpo entero normalizado. */
export function expenseRequestFingerprint(input: ExpenseRequestShape): string {
  const supplier = spaced(input.supplier);
  return sha([
    lowerUuid(input.locationId),
    spaced(input.category),
    supplier === '' ? null : supplier,
    optionalText(input.description),
    money(input.amount),
    currencyCode(input.currency),
    text(input.invoiceDate),
    optionalText(input.dueDate),
    input.payment ? paymentParts(input.payment) : null,
    lowerUuid(input.attachmentUploadId),
  ]);
}

export interface CashOutflowRequestShape {
  category: unknown;
  supplier?: unknown;
  description?: unknown;
  amount: unknown;
  currency: unknown;
  attachmentUploadId?: unknown;
}

/**
 * Huella de una salida de caja (`POST /cash-sessions/current/outflows`): el
 * cuerpo tal cual llegó, con su propia etiqueta. La sede y el día los pone el
 * servidor (la caja abierta y su «hoy»), así que no entran: repetir mañana la
 * misma petición sigue devolviendo la original.
 */
export function cashOutflowFingerprint(input: CashOutflowRequestShape): string {
  const supplier = spaced(input.supplier);
  return sha([
    'CASH_OUTFLOW',
    spaced(input.category),
    supplier === '' ? null : supplier,
    optionalText(input.description),
    money(input.amount),
    currencyCode(input.currency),
    lowerUuid(input.attachmentUploadId),
  ]);
}
