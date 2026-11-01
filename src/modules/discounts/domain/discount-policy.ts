import { ClinicRole, DiscountReason } from '@prisma/client';
import {
  RoundingDigits,
  basisPoints,
  bigCents,
  percentOfCentsInUnits,
  unitCents,
  unitsToAmount,
} from '../../../shared/money/line-rounding';

/**
 * Política de descuentos de la clínica (DX-204): el % máximo de descuento que
 * cada rol puede dar en un ítem del plan y el % por encima del cual el motivo
 * es obligatorio. Funciones puras: el servidor es la frontera (la web solo
 * avisa antes).
 *
 * Toda comparación se hace en céntimos enteros (BigInt): un 10,01 % no pasa
 * por un 10 % por un error de coma flotante.
 */
export interface DiscountPolicyRules {
  maxPercentByRole: Record<ClinicRole, number>;
  /** Estrictamente por encima de este %, el motivo es obligatorio. */
  reasonRequiredAbovePercent: number;
}

export const DEFAULT_DISCOUNT_POLICY: DiscountPolicyRules = {
  maxPercentByRole: {
    [ClinicRole.ADMIN]: 100,
    [ClinicRole.DENTIST]: 10,
    [ClinicRole.ASSISTANT]: 0,
    [ClinicRole.RECEPTION]: 0,
  },
  reasonRequiredAbovePercent: 10,
};

/** Tope de la nota del motivo (también un CHECK en la BD). */
export const DISCOUNT_REASON_NOTE_MAX = 200;

export function roleDiscountCapMessage(maxPercent: number): string {
  return `Tu rol permite hasta un ${maxPercent} % de descuento por ítem.`;
}

export function reasonRequiredMessage(thresholdPercent: number): string {
  return `El descuento supera el ${thresholdPercent} %: indica el motivo.`;
}

export const REASON_NOTE_REQUIRED_MESSAGE = `Con el motivo «Otro», escribe una nota (hasta ${DISCOUNT_REASON_NOTE_MAX} caracteres).`;

export interface ItemDiscountCheckInput {
  price: number;
  discount: number;
  reason: DiscountReason | null;
  reasonNote: string | null;
}

export type ItemDiscountCheck =
  | { kind: 'ok' }
  | { kind: 'over-cap'; maxPercent: number }
  | { kind: 'reason-required'; thresholdPercent: number }
  | { kind: 'note-required' };

/** ¿`discount` supera el `percent` % de `price`? */
function exceeds(price: number, discount: number, percent: number): boolean {
  return bigCents(discount) * 10000n > bigCents(price) * basisPoints(percent);
}

/**
 * Comprueba un descuento contra la política para el rol de quien lo da. Un
 * descuento 0 siempre vale (quitar un descuento no necesita permiso). El orden
 * es el de la respuesta: primero el tope (403), luego el motivo (422).
 */
export function checkItemDiscount(
  policy: DiscountPolicyRules,
  role: ClinicRole,
  input: ItemDiscountCheckInput,
): ItemDiscountCheck {
  if (input.discount <= 0) return { kind: 'ok' };
  const maxPercent = policy.maxPercentByRole[role] ?? 0;
  if (exceeds(input.price, input.discount, maxPercent)) {
    return { kind: 'over-cap', maxPercent };
  }
  const threshold = policy.reasonRequiredAbovePercent;
  if (exceeds(input.price, input.discount, threshold) && !input.reason) {
    return { kind: 'reason-required', thresholdPercent: threshold };
  }
  if (input.reason === DiscountReason.OTHER && !input.reasonNote?.trim()) {
    return { kind: 'note-required' };
  }
  return { kind: 'ok' };
}

/** % del descuento sobre el precio, con 2 decimales (0 si el precio es 0). */
export function discountPercent(price: number, discount: number): number {
  if (price <= 0) return 0;
  return Math.round((discount / price) * 10000) / 100;
}

/**
 * Descuento de un ítem al aplicarle `percent` % (acción en bloque): una línea,
 * redondeada a los `digits` de redondeo de la moneda del plan
 * (`currencies.rounding_digits`, DX-340), la mitad hacia arriba. Si el
 * redondeo lo llevara por encima del tope del rol (`capPercent`), baja a la
 * mayor unidad que lo respeta; nunca supera el precio.
 */
export function discountForPercent(
  price: number,
  percent: number,
  digits: RoundingDigits,
  capPercent: number,
): number {
  const priceCents = bigCents(price);
  const rounded = percentOfCentsInUnits(
    priceCents,
    basisPoints(percent),
    digits,
    'half-up',
  );
  const capped = percentOfCentsInUnits(
    priceCents,
    basisPoints(capPercent),
    digits,
    'floor',
  );
  const whole = priceCents / unitCents(digits);
  let units = rounded;
  if (capped < units) units = capped;
  if (whole < units) units = whole;
  return unitsToAmount(units, digits);
}
