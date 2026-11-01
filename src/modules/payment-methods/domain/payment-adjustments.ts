import type {
  PaymentAdjustmentCalculation,
  PaymentAdjustmentType,
} from '@prisma/client';
import {
  basisPoints,
  bigCents,
  percentOfCentsInUnits,
  unitCents,
  unitsToAmount,
  type RoundingDigits,
} from '../../../shared/money/line-rounding';
import { fromCents, toCents } from '../../../shared/money/money';

/*
 * DX-516: ajustes por medio de pago (impuesto, recargo o descuento). Reglas
 * puras: las usan el catálogo (validar la configuración) y el alta del abono
 * (calcular lo que se congela). Ningún tipo ni etiqueta de un país: la
 * etiqueta es texto de la clínica.
 *
 * Regla de totales (SPEC-DX-516 §2): `payments.amount` es lo que se acredita
 * al plan. Cada ajuste se calcula sobre ese importe (la base, la misma para
 * todos: no se encadenan). Impuestos y recargos se cobran aparte; los
 * descuentos cuentan como abono. Lo cobrado = importe + impuestos + recargos
 * − descuentos, y nunca es negativo.
 */

export const ADJUSTMENT_LABEL_MAX = 40;
export const ADJUSTMENTS_PER_METHOD_MAX = 5;
export const ADJUSTMENT_PERCENT_MAX = 100;

export const ADJUSTMENT_NOT_FOUND_MESSAGE =
  'Ajuste no encontrado en este medio de pago.';
export const ADJUSTMENT_LABEL_REQUIRED_MESSAGE =
  'La etiqueta del ajuste es obligatoria.';
export const ADJUSTMENT_LABEL_TOO_LONG_MESSAGE = `La etiqueta del ajuste admite como mucho ${ADJUSTMENT_LABEL_MAX} caracteres.`;
export const ADJUSTMENT_LABEL_CONTROL_MESSAGE =
  'La etiqueta del ajuste va en una sola línea, sin caracteres especiales.';
export const ADJUSTMENT_LABEL_TAKEN_MESSAGE =
  'Este medio de pago ya tiene un ajuste con esa etiqueta.';
export const ADJUSTMENT_PERCENT_MESSAGE = `El porcentaje tiene que ser mayor que 0 y como mucho ${ADJUSTMENT_PERCENT_MAX}, con hasta 2 decimales.`;
export const ADJUSTMENT_FIXED_MESSAGE =
  'El importe fijo tiene que ser mayor que 0 y llevar su moneda.';
export const ADJUSTMENT_SHAPE_MESSAGE =
  'Un ajuste en porcentaje lleva solo el porcentaje; uno fijo, solo el importe y su moneda.';
export const ADJUSTMENTS_LIMIT_MESSAGE = `Un medio de pago admite como mucho ${ADJUSTMENTS_PER_METHOD_MAX} ajustes activos.`;

export function adjustmentFixedDigitsMessage(
  currency: string,
  digits: RoundingDigits,
): string {
  return digits === 0
    ? `El importe fijo en ${currency} va sin decimales.`
    : `El importe fijo en ${currency} admite como mucho ${digits} decimales.`;
}

/** Un ajuste tal como lo configura la clínica (lo que el cálculo necesita). */
export interface AdjustmentRule {
  id: string;
  type: PaymentAdjustmentType;
  label: string;
  calculation: PaymentAdjustmentCalculation;
  /** Solo con PERCENT. */
  percent: number | null;
  /** Solo con FIXED, con su moneda. */
  fixedAmount: number | null;
  fixedCurrency: string | null;
  active: boolean;
}

/** Una línea congelada en el abono. */
export interface ComputedAdjustment {
  position: number;
  sourceAdjustmentId: string | null;
  type: PaymentAdjustmentType;
  label: string;
  calculation: PaymentAdjustmentCalculation;
  percent: number | null;
  fixedAmount: number | null;
  /** El importe del abono. */
  base: number;
  /** > 0, en la moneda del abono. */
  amount: number;
  currency: string;
}

const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** El error de una etiqueta, o `null` si vale (ya recortada fuera). */
export function adjustmentLabelError(label: string): string | null {
  const trimmed = label.trim();
  if (trimmed.length === 0) return ADJUSTMENT_LABEL_REQUIRED_MESSAGE;
  if ([...trimmed].length > ADJUSTMENT_LABEL_MAX) {
    return ADJUSTMENT_LABEL_TOO_LONG_MESSAGE;
  }
  if (CONTROL.test(trimmed)) return ADJUSTMENT_LABEL_CONTROL_MESSAGE;
  return null;
}

/** ¿Un porcentaje válido? (0, 100] con hasta 2 decimales. */
export function isValidAdjustmentPercent(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= ADJUSTMENT_PERCENT_MAX &&
    Math.abs(value * 100 - Number(basisPoints(value))) < 1e-6
  );
}

/** ¿Un importe con los decimales de redondeo de su moneda (DX-340)? */
export function fitsCurrencyDigits(
  amount: number,
  digits: RoundingDigits,
): boolean {
  const cents = amount * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-6) return false;
  return BigInt(Math.round(cents)) % unitCents(digits) === 0n;
}

/** ¿Este ajuste se aplica a un abono en `currency`? */
export function adjustmentApplies(
  rule: AdjustmentRule,
  currency: string,
): boolean {
  if (!rule.active) return false;
  if (rule.calculation === 'FIXED') {
    return rule.fixedCurrency?.toUpperCase() === currency.toUpperCase();
  }
  return true;
}

/** Signo con que cuenta un ajuste en lo cobrado. */
export function adjustmentSign(type: PaymentAdjustmentType): 1 | -1 {
  return type === 'DISCOUNT' ? -1 : 1;
}

/**
 * Las líneas que congela un abono de `amount` en `currency` con los ajustes
 * de su medio (en el orden en que se configuraron): solo los activos que se
 * aplican a esa moneda, cada uno sobre el importe del abono, redondeado a
 * los decimales de la moneda (la mitad hacia arriba). Una línea en 0 no se
 * crea. Los descuentos se topan para que lo cobrado no sea negativo.
 */
export function computePaymentAdjustments(
  rules: readonly AdjustmentRule[],
  amount: number,
  currency: string,
  digits: RoundingDigits,
): ComputedAdjustment[] {
  const baseCents = bigCents(amount);
  if (baseCents <= 0n) return [];
  const computed: { rule: AdjustmentRule; cents: bigint }[] = [];
  for (const rule of rules) {
    if (!adjustmentApplies(rule, currency)) continue;
    const cents =
      rule.calculation === 'PERCENT'
        ? percentOfCentsInUnits(
            baseCents,
            basisPoints(rule.percent ?? 0),
            digits,
            'half-up',
          ) * unitCents(digits)
        : bigCents(rule.fixedAmount ?? 0);
    if (cents > 0n) computed.push({ rule, cents });
  }

  // Tope de los descuentos: lo cobrado (base + cargos − descuentos) >= 0.
  let room =
    baseCents +
    computed
      .filter((c) => c.rule.type !== 'DISCOUNT')
      .reduce((sum, c) => sum + c.cents, 0n);
  const capped = computed.map((c) => {
    if (c.rule.type !== 'DISCOUNT') return c;
    const cents = c.cents > room ? room : c.cents;
    room -= cents;
    return { ...c, cents };
  });

  return capped
    .filter((c) => c.cents > 0n)
    .map((c, index) => ({
      position: index + 1,
      sourceAdjustmentId: c.rule.id,
      type: c.rule.type,
      label: c.rule.label,
      calculation: c.rule.calculation,
      percent: c.rule.calculation === 'PERCENT' ? c.rule.percent : null,
      fixedAmount: c.rule.calculation === 'FIXED' ? c.rule.fixedAmount : null,
      base: amount,
      amount: unitsToAmount(c.cents / unitCents(digits), digits),
      currency,
    }));
}

/** Ajustes con signo de un abono, en céntimos (cargos +, descuentos −). */
export function adjustmentsNetCents(
  lines: readonly { type: PaymentAdjustmentType; amount: number }[],
): number {
  return lines.reduce(
    (sum, line) => sum + adjustmentSign(line.type) * toCents(line.amount),
    0,
  );
}

/** Lo cobrado de un abono: importe + impuestos + recargos − descuentos. */
export function collectedAmount(
  amount: number,
  lines: readonly { type: PaymentAdjustmentType; amount: number }[],
): number {
  return fromCents(toCents(amount) + adjustmentsNetCents(lines));
}
