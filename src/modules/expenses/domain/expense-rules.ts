import {
  MONEY_MAX,
  decimalPlaces,
} from '../../../shared/validation/bounded-decimal';
import type { ExpenseStatus } from './entities/expense.entity';

/**
 * Reglas puras de un gasto (DX-274). Sin Nest ni Prisma: fallan con
 * `ExpenseRuleError` y el caso de uso las traduce a 400/404/409 con el mensaje
 * tal cual (en español, listo para la pantalla). Los repositorios las
 * aplican DENTRO de la transacción, con el gasto bloqueado.
 */
export type ExpenseRuleKind = 'INVALID' | 'NOT_FOUND' | 'CONFLICT';

export class ExpenseRuleError extends Error {
  constructor(
    message: string,
    readonly kind: ExpenseRuleKind,
  ) {
    super(message);
    this.name = 'ExpenseRuleError';
  }
}

const invalid = (message: string) => new ExpenseRuleError(message, 'INVALID');
const conflict = (message: string) => new ExpenseRuleError(message, 'CONFLICT');

// --- Mensajes (parte del contrato con la web) -------------------------------
export const EXPENSE_NOT_FOUND_MESSAGE = 'Gasto no encontrado.';
export const PAYMENT_NOT_FOUND_MESSAGE = 'Pago no encontrado.';
export const LOCATION_INVALID_MESSAGE = 'La sede no es válida.';
export const UNKNOWN_CURRENCY_MESSAGE = 'La moneda no es válida.';
export const CATEGORY_INVALID_MESSAGE = 'Elige una categoría válida.';
export const CATEGORY_DUPLICATE_MESSAGE =
  'Ya existe una categoría con ese nombre.';
export const CATEGORY_NAME_MESSAGE =
  'El nombre de la categoría debe tener entre 2 y 60 caracteres.';
export const CATEGORY_NOT_FOUND_MESSAGE = 'Categoría no encontrada.';
export const AMOUNT_MESSAGE =
  'El importe debe ser mayor que cero, con hasta 2 decimales.';
export const SUPPLIER_MESSAGE = 'El proveedor admite hasta 200 caracteres.';
export const DESCRIPTION_MESSAGE =
  'La descripción admite hasta 500 caracteres.';
export const CONTROL_CHARS_MESSAGE =
  'El texto contiene caracteres no permitidos.';
export const INVOICE_DATE_INVALID_MESSAGE =
  'La fecha de la factura no es válida.';
export const INVOICE_DATE_FUTURE_MESSAGE =
  'La fecha de la factura no puede ser futura.';
export const DUE_DATE_INVALID_MESSAGE = 'La fecha de vencimiento no es válida.';
export const DUE_BEFORE_INVOICE_MESSAGE =
  'El vencimiento no puede ser anterior a la fecha de la factura.';
export const PAID_ON_INVALID_MESSAGE = 'La fecha del pago no es válida.';
export const PAID_ON_FUTURE_MESSAGE = 'La fecha del pago no puede ser futura.';
export const VOID_REASON_MESSAGE =
  'El motivo debe tener entre 5 y 500 caracteres.';
export const EXPENSE_VOIDED_MESSAGE = 'El gasto está anulado.';
export const EXPENSE_ALREADY_VOIDED_MESSAGE = 'El gasto ya está anulado.';
export const EXPENSE_VOIDED_EDIT_MESSAGE =
  'El gasto está anulado y no se puede editar.';
export const PAYMENT_ALREADY_VOIDED_MESSAGE = 'El pago ya está anulado.';
export const HAS_PAYMENTS_MESSAGE =
  'El gasto ya tiene pagos; anúlalo y regístralo de nuevo para cambiar la sede o la moneda.';
/** Efectivo fuera de caja en una clínica con «exigir caja abierta» (R1). */
export const EXPENSE_CASH_ALWAYS_IN_SESSION_MESSAGE =
  'Esta clínica registra el efectivo siempre en una caja abierta.';
/** Pago o salida desde el cajón sin caja abierta de quien paga en la sede (R1). */
export const OPEN_CASH_SESSION_REQUIRED_MESSAGE =
  'Abre tu caja en esta sede para pagar desde el cajón.';
export const CASH_SESSION_IN_SEVERAL_LOCATIONS_MESSAGE =
  'Tienes cajas abiertas en varias sedes: elige la sede de la caja de la que sale el dinero.';
export const FROM_CASH_METHOD_MESSAGE =
  'Un pago desde la caja es siempre en efectivo.';
export const FROM_CASH_PAID_ON_MESSAGE =
  'Un pago desde la caja es de hoy: no admite otra fecha.';
export const ATTACHMENT_ALREADY_MESSAGE = 'El gasto ya tiene un soporte.';
export const IDEMPOTENCY_KEY_INVALID_MESSAGE =
  'La clave de idempotencia debe ser un UUID.';
export const IDEMPOTENCY_KEY_REUSED_MESSAGE =
  'Esta clave de idempotencia ya se usó con otros datos. Vuelve a enviar el formulario para generar una clave nueva.';

export const CATEGORY_NAME_MIN = 2;
export const CATEGORY_NAME_MAX = 60;
export const SUPPLIER_MAX = 200;
export const DESCRIPTION_MAX = 500;
export const VOID_REASON_MIN = 5;
export const VOID_REASON_MAX = 500;

/** Longitud en puntos de código, como `char_length` de Postgres. */
const codePoints = (value: string): number => Array.from(value).length;

/**
 * Controles C0/C1 salvo tabulador, salto de línea y retorno de carro. Postgres
 * rechaza 0x00 en `text`. Se rechaza en vez de quitarlo: no se cambia en
 * silencio lo que escribió el usuario.
 */
const FORBIDDEN_CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex -- detectar controles es justo lo que se quiere
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function assertNoControlChars(value: string): void {
  if (FORBIDDEN_CONTROL_CHARS.test(value)) throw invalid(CONTROL_CHARS_MESSAGE);
}

// --- Dinero -----------------------------------------------------------------
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/** Importe > 0, hasta 2 decimales y dentro de `Decimal(14,2)`. */
export function validateAmount(amount: unknown): number {
  if (
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > MONEY_MAX ||
    decimalPlaces(amount) > 2
  ) {
    throw invalid(AMOUNT_MESSAGE);
  }
  return amount;
}

/**
 * «1.234,50 COP»: miles con punto y coma decimal solo si hay céntimos. Es el
 * formato del mensaje de tope (R2), el mismo que ve la clínica en pantalla.
 */
export function formatMoney(cents: number, currency: string): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const fraction = abs % 100;
  const decimals =
    fraction === 0 ? '' : `,${fraction.toString().padStart(2, '0')}`;
  return `${cents < 0 ? '-' : ''}${whole}${decimals} ${currency}`;
}

// --- Textos -----------------------------------------------------------------
/** Espacios de los extremos fuera y los internos colapsados a uno. */
export function normalizeSupplier(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** Proveedor opcional: normalizado, ≤ 200; vacío → null. */
export function validateSupplier(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const supplier = normalizeSupplier(raw);
  if (supplier === '') return null;
  assertNoControlChars(supplier);
  if (codePoints(supplier) > SUPPLIER_MAX) throw invalid(SUPPLIER_MESSAGE);
  return supplier;
}

/** Descripción opcional: recortada, ≤ 500; vacía → null. */
export function validateDescription(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const description = raw.trim();
  if (description === '') return null;
  assertNoControlChars(description);
  if (codePoints(description) > DESCRIPTION_MAX) {
    throw invalid(DESCRIPTION_MESSAGE);
  }
  return description;
}

/** Nombre de una categoría propia: 2–60 tras normalizar, sin controles. */
export function validateCategoryName(raw: string | null | undefined): string {
  const name = (raw ?? '').trim().replace(/\s+/g, ' ');
  assertNoControlChars(name);
  const length = codePoints(name);
  if (length < CATEGORY_NAME_MIN || length > CATEGORY_NAME_MAX) {
    throw invalid(CATEGORY_NAME_MESSAGE);
  }
  return name;
}

/** Motivo de anulación: 5–500 tras recortar, sin controles. */
export function validateVoidReason(raw: string | null | undefined): string {
  const reason = (raw ?? '').trim();
  assertNoControlChars(reason);
  const length = codePoints(reason);
  if (length < VOID_REASON_MIN || length > VOID_REASON_MAX) {
    throw invalid(VOID_REASON_MESSAGE);
  }
  return reason;
}

// --- Fechas (días civiles YYYY-MM-DD) ---------------------------------------
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `value` si es un día de calendario real; si no, null. */
export function parseDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = ISO_DATE.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
    ? value.trim()
    : null;
}

/** Fecha de factura: real y no futura respecto al día civil de la sede. */
export function validateInvoiceDate(value: unknown, today: string): string {
  const day = parseDay(value);
  if (day === null) throw invalid(INVOICE_DATE_INVALID_MESSAGE);
  if (day > today) throw invalid(INVOICE_DATE_FUTURE_MESSAGE);
  return day;
}

/** Vencimiento opcional: real y no anterior a la fecha de factura. */
export function validateDueDate(
  value: unknown,
  invoiceDate: string,
): string | null {
  if (value === null || value === undefined || value === '') return null;
  const day = parseDay(value);
  if (day === null) throw invalid(DUE_DATE_INVALID_MESSAGE);
  if (day < invoiceDate) throw invalid(DUE_BEFORE_INVOICE_MESSAGE);
  return day;
}

/** Día del pago: real y no futuro respecto al día civil de la sede. */
export function validatePaidOn(value: unknown, today: string): string {
  const day = parseDay(value);
  if (day === null) throw invalid(PAID_ON_INVALID_MESSAGE);
  if (day > today) throw invalid(PAID_ON_FUTURE_MESSAGE);
  return day;
}

/**
 * Pago desde la caja abierta (R1): siempre en efectivo y de hoy en la sede.
 * Devuelve el día del pago (hoy); un `paidOn` distinto es un 400.
 */
export function validateFromCashPayment(
  method: unknown,
  paidOn: unknown,
  today: string,
): string {
  if (method !== 'CASH') throw invalid(FROM_CASH_METHOD_MESSAGE);
  if (paidOn !== undefined && paidOn !== null && parseDay(paidOn) !== today) {
    throw invalid(FROM_CASH_PAID_ON_MESSAGE);
  }
  return today;
}

// --- Estado derivado (R2) ---------------------------------------------------
export interface ExpenseStatusInput {
  amountCents: number;
  /** Σ de los pagos vivos, en céntimos. */
  paidCents: number;
  voided: boolean;
  dueDate: string | null;
}

/**
 * VOIDED si está anulado; si no PAID (Σ vivos = importe), PARTIAL (0 < Σ <
 * importe) o PENDING. `overdue`: no anulado ni pagado del todo, con el
 * vencimiento ya pasado (`today` es el día civil de la sede del gasto).
 */
export function expenseStatus(
  e: ExpenseStatusInput,
  today: string,
): { status: ExpenseStatus; overdue: boolean } {
  if (e.voided) return { status: 'VOIDED', overdue: false };
  const status: ExpenseStatus =
    e.paidCents >= e.amountCents
      ? 'PAID'
      : e.paidCents > 0
        ? 'PARTIAL'
        : 'PENDING';
  return {
    status,
    overdue: status !== 'PAID' && e.dueDate !== null && e.dueDate < today,
  };
}

// --- Tope de pagos (R2) -----------------------------------------------------
/**
 * Σ de pagos vivos ≤ importe. `liveCents` se lee con la fila del gasto
 * bloqueada (`FOR UPDATE`), así que dos pagos a la vez no pueden pasarse.
 */
export function paymentCapDenial(input: {
  amountCents: number;
  liveCents: number;
  paymentCents: number;
  currency: string;
}): ExpenseRuleError | null {
  const pending = input.amountCents - input.liveCents;
  if (input.paymentCents > pending) {
    return invalid(
      `El pago supera lo pendiente del gasto (${formatMoney(Math.max(pending, 0), input.currency)}).`,
    );
  }
  return null;
}

// --- Edición ----------------------------------------------------------------
export interface ExpenseEditContext {
  current: {
    amountCents: number;
    locationId: string;
    currency: string;
    voided: boolean;
  };
  /** Solo lo que cambia de verdad respecto al gasto actual. */
  patch: { amountCents?: number; locationId?: string; currency?: string };
  /** Σ de los pagos vivos, en céntimos. */
  liveCents: number;
  /** Pagos del gasto, vivos o anulados (la FK de cuatro columnas los ata). */
  paymentCount: number;
  currency: string;
}

/**
 * Un gasto anulado no se edita. La sede y la moneda no cambian con CUALQUIER
 * pago (aunque esté anulado: la FK compuesta lo prohíbe). El importe sí, pero
 * nunca por debajo de lo ya pagado.
 */
export function expenseEditDenial(
  ctx: ExpenseEditContext,
): ExpenseRuleError | null {
  if (ctx.current.voided) return conflict(EXPENSE_VOIDED_EDIT_MESSAGE);
  const movesLocation =
    ctx.patch.locationId !== undefined &&
    ctx.patch.locationId !== ctx.current.locationId;
  const movesCurrency =
    ctx.patch.currency !== undefined &&
    ctx.patch.currency !== ctx.current.currency;
  if ((movesLocation || movesCurrency) && ctx.paymentCount > 0) {
    return conflict(HAS_PAYMENTS_MESSAGE);
  }
  if (
    ctx.patch.amountCents !== undefined &&
    ctx.patch.amountCents < ctx.liveCents
  ) {
    return conflict(
      `El importe no puede ser menor a lo ya pagado (${formatMoney(ctx.liveCents, ctx.currency)}).`,
    );
  }
  return null;
}
