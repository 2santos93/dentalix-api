import { createHash } from 'node:crypto';
import { fromCents, toCents } from '../../../shared/money/money';

/**
 * DX-464: el pago de una liquidación cerrada (DX-018), sin base de datos.
 * Se paga por líneas y por moneda: el importe de un pago es la suma de sus
 * líneas (nunca se teclea), así que no puede pasar de lo pendiente salvo que
 * se dejen fuera los ajustes negativos, y eso se frena aquí.
 */

/** Una línea congelada de la liquidación con el pago vivo que la cubre. */
export interface PayableLine {
  id: string;
  currency: string;
  amount: number;
  /** Pago vivo que ya la cubre, o null si está pendiente. */
  paymentId: string | null;
}

export type SettlementPaymentStatus =
  'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'NOTHING_TO_PAY';

export interface CurrencyPaymentState {
  currency: string;
  /** A pagar: Σ de las líneas (devengos + ajustes). */
  total: number;
  /** Σ de las líneas con pago vivo. */
  paid: number;
  /** total − pagado (≤ 0: nada más que pagar en esta moneda). */
  pending: number;
  /** Líneas aún sin pago vivo. */
  pendingLines: number;
}

export interface SettlementPaymentState {
  status: SettlementPaymentStatus;
  currencies: CurrencyPaymentState[];
}

/** El estado de pago, por moneda y global, de las líneas de una liquidación. */
export function settlementPaymentState(
  lines: readonly PayableLine[],
): SettlementPaymentState {
  const acc = new Map<
    string,
    { total: number; paid: number; pendingLines: number }
  >();
  for (const line of lines) {
    const row = acc.get(line.currency) ?? {
      total: 0,
      paid: 0,
      pendingLines: 0,
    };
    const cents = toCents(line.amount);
    row.total += cents;
    if (line.paymentId !== null) row.paid += cents;
    else row.pendingLines += 1;
    acc.set(line.currency, row);
  }
  const currencies = [...acc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, row]) => ({
      currency,
      total: fromCents(row.total),
      paid: fromCents(row.paid),
      pending: fromCents(row.total - row.paid),
      pendingLines: row.pendingLines,
    }));
  const anyPaid = lines.some((l) => l.paymentId !== null);
  const anyPending = currencies.some((c) => c.pending > 0);
  const status: SettlementPaymentStatus = anyPaid
    ? anyPending
      ? 'PARTIALLY_PAID'
      : 'PAID'
    : anyPending
      ? 'UNPAID'
      : 'NOTHING_TO_PAY';
  return { status, currencies };
}

export type PaymentPlanError =
  | { code: 'COMMISSION_NOTHING_PENDING' }
  | { code: 'COMMISSION_PAYMENT_LINE_UNKNOWN' }
  | { code: 'COMMISSION_PAYMENT_LINE_CURRENCY' }
  | { code: 'COMMISSION_LINE_ALREADY_PAID' }
  | { code: 'COMMISSION_PAYMENT_NOT_POSITIVE' }
  | { code: 'COMMISSION_PAYMENT_EXCEEDS_PENDING'; pending: number };

export const PAYMENT_PLAN_MESSAGES: Record<PaymentPlanError['code'], string> = {
  COMMISSION_NOTHING_PENDING:
    'No queda nada pendiente de pagar en esa moneda: la liquidación ya está pagada.',
  COMMISSION_PAYMENT_LINE_UNKNOWN:
    'Alguna de las líneas elegidas no es de esta liquidación.',
  COMMISSION_PAYMENT_LINE_CURRENCY:
    'Cada pago es de una sola moneda: elige líneas de la moneda del pago.',
  COMMISSION_LINE_ALREADY_PAID:
    'Alguna de las líneas elegidas ya está pagada. Actualiza la liquidación y vuelve a elegir.',
  COMMISSION_PAYMENT_NOT_POSITIVE:
    'El pago tiene que ser mayor que cero: elige también líneas a favor del profesional.',
  COMMISSION_PAYMENT_EXCEEDS_PENDING:
    'Ese pago supera lo pendiente de la moneda: incluye también los ajustes a descontar.',
};

/** Qué cubre un pago: sus líneas y su importe (la suma de ellas). */
export interface PaymentPlan {
  lineIds: string[];
  amount: number;
}

/**
 * Las líneas y el importe de un pago en `currency`. Sin `requested`, todas las
 * pendientes de esa moneda. Reglas: líneas de esta liquidación, de la moneda
 * del pago y aún sin pago vivo; importe > 0 y ≤ lo pendiente de la moneda.
 */
export function planPayment(
  lines: readonly PayableLine[],
  currency: string,
  requested: readonly string[] | undefined,
): { ok: true; plan: PaymentPlan } | { ok: false; error: PaymentPlanError } {
  const inCurrency = lines.filter((l) => l.currency === currency);
  const state = settlementPaymentState(inCurrency);
  const pendingCents = toCents(state.currencies[0]?.pending ?? 0);
  if (pendingCents <= 0) {
    return { ok: false, error: { code: 'COMMISSION_NOTHING_PENDING' } };
  }
  let chosen: PayableLine[];
  if (requested === undefined) {
    chosen = inCurrency.filter((l) => l.paymentId === null);
  } else {
    const byId = new Map(lines.map((l) => [l.id, l]));
    chosen = [];
    for (const id of new Set(requested)) {
      const line = byId.get(id);
      if (!line) {
        return {
          ok: false,
          error: { code: 'COMMISSION_PAYMENT_LINE_UNKNOWN' },
        };
      }
      if (line.currency !== currency) {
        return {
          ok: false,
          error: { code: 'COMMISSION_PAYMENT_LINE_CURRENCY' },
        };
      }
      if (line.paymentId !== null) {
        return { ok: false, error: { code: 'COMMISSION_LINE_ALREADY_PAID' } };
      }
      chosen.push(line);
    }
  }
  const cents = chosen.reduce((sum, l) => sum + toCents(l.amount), 0);
  if (chosen.length === 0 || cents <= 0) {
    return { ok: false, error: { code: 'COMMISSION_PAYMENT_NOT_POSITIVE' } };
  }
  if (cents > pendingCents) {
    return {
      ok: false,
      error: {
        code: 'COMMISSION_PAYMENT_EXCEEDS_PENDING',
        pending: fromCents(pendingCents),
      },
    };
  }
  return {
    ok: true,
    plan: { lineIds: chosen.map((l) => l.id), amount: fromCents(cents) },
  };
}

export const PAYMENT_REFERENCE_MAX = 120;
export const PAYMENT_REFERENCE_MESSAGE = `La referencia del pago va sin saltos de línea y con hasta ${PAYMENT_REFERENCE_MAX} caracteres.`;

/** Referencia opcional: recortada, sin controles, ≤ 120; vacía → null. */
export function parsePaymentReference(
  raw: string | null | undefined,
): { ok: true; value: string | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const value = raw.trim();
  if (value === '') return { ok: true, value: null };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return { ok: false };
  if (Array.from(value).length > PAYMENT_REFERENCE_MAX) return { ok: false };
  return { ok: true, value };
}

/**
 * Iniciales del paciente para lo que sale de la clínica (PDF y enlace): la
 * primera letra de cada palabra del nombre, con punto («María José Pérez» →
 * «M. J. P.»). Nunca el nombre completo.
 */
export function patientInitials(name: string | null | undefined): string {
  const words = (name ?? '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const letters = words
    .map((w) => Array.from(w.normalize('NFC')).find((c) => /\p{L}/u.test(c)))
    .filter((c): c is string => c !== undefined)
    .map((c) => `${c.toLocaleUpperCase('es')}.`);
  return letters.length > 0 ? letters.join(' ') : '—';
}

/** Texto de la descripción del gasto: período y, si hay, la referencia. */
export function expenseDescription(
  period: { from: string; to: string },
  reference: string | null,
): string {
  const base = `Liquidación de honorarios del ${period.from} al ${period.to}`;
  return reference ? `${base} · Ref. ${reference}` : base;
}

/** JSON canónico (claves ordenadas) para hashear la foto del recibo. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Huella de la conformidad: la del recibo congelado encadenada al nombre y la
 * firma. Cambiar cualquiera de las tres cambia la huella.
 */
export function receiptSignatureHash(
  contentHash: string,
  signerName: string,
  signature: string,
): string {
  return sha256Hex(`${contentHash}\n${signerName}\n${signature}`);
}
