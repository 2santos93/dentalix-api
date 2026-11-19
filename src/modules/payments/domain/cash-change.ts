import type { ExchangeRateSource, PaymentMethod } from '@prisma/client';
import { amountText, fromCents } from '../../../shared/money/money';

/*
 * DX-570: vuelto al cobrar en efectivo. El paciente entrega más de lo que se
 * cobra («Recibido») y la clínica devuelve la diferencia en una o varias
 * líneas, en la moneda y por el medio que tenga a mano (billetes de otra
 * moneda, una transferencia inmediata…). Reglas puras, en céntimos enteros:
 *
 *   cobrado   = importe + ajustes por medio de pago (DX-516)
 *   debido    = recibido − cobrado                   (>= 0)
 *   vuelto    = Σ equivalentes de las líneas en la moneda del abono
 *   resto     = debido − vuelto                      (>= 0)
 *
 * El vuelto no puede superar lo debido. Un resto sin devolver solo se admite
 * confirmado: se suma al importe del abono (lo aplicado al plan; si supera lo
 * pendiente queda como saldo a favor, como cualquier abono de más). Con
 * ajustes por medio de pago el importe es su base y no cambia: el resto no
 * se admite. Guardado, siempre: recibido = importe + ajustes + vuelto.
 * Nada aquí sabe de países, bancos ni monedas concretas.
 */

export const CHANGE_LINES_MAX = 3;

/** Código estable del 422 del resto sin confirmar (la web lo pinta como aviso). */
export const CASH_CHANGE_REMAINDER = 'CASH_CHANGE_REMAINDER';

export const CHANGE_NOT_CASH_MESSAGE =
  'Lo recibido y el vuelto solo se registran en un abono en efectivo.';
export const CASH_CHANGE_NOT_HERE_MESSAGE =
  'El vuelto solo se registra en un abono suelto en efectivo a un plan de tratamiento.';
export const CHANGE_WITHOUT_TENDERED_MESSAGE =
  'Indica lo recibido para registrar el vuelto.';
export const REMAINDER_WITHOUT_TENDERED_MESSAGE =
  'Solo hay diferencia que sumar al abono si indicas lo recibido.';
export const CHANGE_LINES_LIMIT_MESSAGE = `El vuelto admite como mucho ${CHANGE_LINES_MAX} líneas.`;
export const CHANGE_REMAINDER_WITH_ADJUSTMENTS_MESSAGE =
  'Este medio de pago tiene ajustes (impuesto, recargo o descuento) calculados sobre el importe: devuelve el vuelto completo o cambia el importe del abono.';

export function tenderedBelowCollectedMessage(
  collected: string,
  currency: string,
): string {
  return `Lo recibido no cubre lo cobrado (${collected} ${currency}).`;
}

export function changeExceedsMessage(
  change: string,
  due: string,
  currency: string,
): string {
  return `El vuelto (${change} ${currency}) supera lo recibido menos lo cobrado (${due} ${currency}).`;
}

export function changeRemainderMessage(
  remainder: string,
  currency: string,
): string {
  return `Quedan ${remainder} ${currency} sin devolver. Completa el vuelto o confirma que se suman al abono (si superan lo pendiente, quedan como saldo a favor del paciente).`;
}

export function changeRateMissingMessage(from: string, to: string): string {
  return `No hay tasa del día entre ${from} y ${to}: no se puede calcular el vuelto en esa moneda. Registra la tasa del día o da el vuelto en ${to}.`;
}

export function changeLineTooSmallMessage(line: number): string {
  return `La línea ${line} del vuelto es demasiado pequeña: en la moneda del abono no llega a una unidad.`;
}

export function changeDigitsMessage(currency: string, digits: number): string {
  return digits === 0
    ? `El vuelto en ${currency} va sin decimales.`
    : `El vuelto en ${currency} admite como mucho ${digits} decimales.`;
}

export function tenderedDigitsMessage(
  currency: string,
  digits: number,
): string {
  return digits === 0
    ? `Lo recibido en ${currency} va sin decimales.`
    : `Lo recibido en ${currency} admite como mucho ${digits} decimales.`;
}

/** La tasa congelada de una línea en otra moneda (unidades por 1 USD). */
export interface ChangeLineRate {
  /** Unidades de la moneda de la línea por 1 USD. */
  fromPerBase: number;
  /** Unidades de la moneda del abono por 1 USD. */
  toPerBase: number;
  source: ExchangeRateSource;
  /** Día civil de la tasa usada (AAAA-MM-DD). */
  date: string;
}

/** Una línea de vuelto lista para guardar (ya validada y convertida). */
export interface PreparedChangeLine {
  line: number;
  paymentMethodId: string;
  paymentMethodName: string;
  /** Tipo base antiguo del medio: el grupo del arqueo. */
  method: PaymentMethod;
  currency: string;
  amount: number;
  reference: string | null;
  referenceNormalized: string | null;
  /** La línea en la moneda del abono. */
  equivalentAmount: number;
  /** `null` en la misma moneda del abono. */
  rate: ChangeLineRate | null;
}

/** El vuelto de un abono, tal como se guarda y se lee. */
export interface PaymentCashChange {
  /** «Recibido», en la moneda del abono. */
  tendered: number;
  /** Lo que se sumó al importe por confirmación (0 si nada). */
  remainderToCredit: number;
  lines: PreparedChangeLine[];
}

export type CashChangeOutcome =
  | { kind: 'ok'; remainderCents: number }
  | { kind: 'tendered-below-collected' }
  | { kind: 'change-exceeds'; changeCents: number; dueCents: number }
  | { kind: 'remainder-unconfirmed'; remainderCents: number }
  | { kind: 'remainder-with-adjustments'; remainderCents: number };

/**
 * El cuadre del vuelto (todo en céntimos de la moneda del abono). `ok` trae
 * el resto que se suma al importe (0 si el vuelto lo cubre todo).
 */
export function settleCashChange(input: {
  tenderedCents: number;
  collectedCents: number;
  changeEquivalentCents: readonly number[];
  remainderToCredit: boolean;
  hasAdjustments: boolean;
}): CashChangeOutcome {
  const due = input.tenderedCents - input.collectedCents;
  if (due < 0) return { kind: 'tendered-below-collected' };
  const change = input.changeEquivalentCents.reduce((s, c) => s + c, 0);
  if (change > due) {
    return { kind: 'change-exceeds', changeCents: change, dueCents: due };
  }
  const remainder = due - change;
  if (remainder === 0) return { kind: 'ok', remainderCents: 0 };
  if (input.hasAdjustments) {
    return { kind: 'remainder-with-adjustments', remainderCents: remainder };
  }
  if (!input.remainderToCredit) {
    return { kind: 'remainder-unconfirmed', remainderCents: remainder };
  }
  return { kind: 'ok', remainderCents: remainder };
}

/** Un importe en céntimos como texto con 2 decimales (mensajes y huellas). */
export function centsText(cents: number): string {
  return amountText(fromCents(cents), 2);
}

/**
 * DX-570: la tasa de una línea de vuelto como se lee en el recibo: una unidad
 * de la moneda más fuerte (la de menos unidades por 1 USD) en la otra, p. ej.
 * «1 USD = 36,5 VES». `number` formatea con los ajustes de la sede.
 */
export function changeRateText(
  rate: { fromPerBase: number; toPerBase: number },
  lineCurrency: string,
  paymentCurrency: string,
  number: (value: number) => string,
): string {
  const lineIsStronger = rate.fromPerBase < rate.toPerBase;
  const [unit, other] = lineIsStronger
    ? [lineCurrency, paymentCurrency]
    : [paymentCurrency, lineCurrency];
  const value = lineIsStronger
    ? rate.toPerBase / rate.fromPerBase
    : rate.fromPerBase / rate.toPerBase;
  return `1 ${unit} = ${number(value)} ${other}`;
}
