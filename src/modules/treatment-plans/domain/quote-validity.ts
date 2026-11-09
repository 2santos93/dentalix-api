import {
  addCivilDays,
  civilDateIn,
  civilDaysInclusive,
} from '../../../shared/time/civil-day';

/**
 * Validez del presupuesto (DX-379). La clínica elige cuántos días vale un
 * presupuesto (`Tenant.quoteValidityDays`, igual en todas sus sedes). Las dos
 * fechas se GUARDAN en el plan al presentarlo o al imprimirlo por primera vez
 * (`quoteIssuedOn`, `quoteValidUntil`): reimprimir otro día no las mueve, y
 * cambiar el ajuste no toca lo ya guardado.
 */
export interface QuoteSettings {
  /** Días civiles que vale un presupuesto desde que se emite. */
  validityDays: number;
}

/** Días de plataforma: los de toda clínica que no eligió otros. */
export const PLATFORM_DEFAULT_QUOTE_VALIDITY_DAYS = 30;

export const QUOTE_VALIDITY_DAYS_MIN = 1;
export const QUOTE_VALIDITY_DAYS_MAX = 365;
export const QUOTE_VALIDITY_DAYS_MESSAGE =
  'La validez del presupuesto tiene que ser un número entero de días entre 1 y 365.';

export function isValidQuoteValidityDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= QUOTE_VALIDITY_DAYS_MIN &&
    value <= QUOTE_VALIDITY_DAYS_MAX
  );
}

/** Código de auditoría: QT_V{días}, p. ej. QT_V30. */
export function quoteSettingsCode(s: QuoteSettings): string {
  return `QT_V${s.validityDays}`;
}

/** Día de emisión y de vencimiento (`YYYY-MM-DD`, días civiles de la sede). */
export interface QuoteValidity {
  issuedOn: string;
  validUntil: string;
}

/**
 * La validez de un presupuesto emitido en el instante `now` en una sede de
 * zona `timeZone`: emitido hoy (día civil de la sede) y vence `days` días
 * después.
 */
export function issueQuoteValidity(
  now: Date,
  timeZone: string,
  days: number,
): QuoteValidity {
  if (!isValidQuoteValidityDays(days)) {
    throw new RangeError(`Invalid quote validity days: ${String(days)}`);
  }
  const issuedOn = civilDateIn(now, timeZone);
  return { issuedOn, validUntil: addCivilDays(issuedOn, days) };
}

/** Días de validez: de la emisión al vencimiento (lo que imprime «Válido N días»). */
export function quoteValidityDays(validity: QuoteValidity): number {
  return civilDaysInclusive(validity.issuedOn, validity.validUntil) - 1;
}

/**
 * Las fechas guardadas en el plan, o `null` si no las tiene (plan anterior a
 * DX-379 o borrador nunca impreso). La base exige las dos o ninguna.
 */
export function storedQuoteValidity(plan: {
  quoteIssuedOn: string | null;
  quoteValidUntil: string | null;
}): QuoteValidity | null {
  return plan.quoteIssuedOn !== null && plan.quoteValidUntil !== null
    ? { issuedOn: plan.quoteIssuedOn, validUntil: plan.quoteValidUntil }
    : null;
}

/**
 * ¿Venció el presupuesto? (D-13): sí cuando hoy, en la zona de la sede, es
 * POSTERIOR a `validUntil` (el último día todavía vale). Sin fecha guardada
 * nunca vence.
 */
export function isQuoteExpired(
  validUntil: string | null,
  now: Date,
  timeZone: string,
): boolean {
  return validUntil !== null && civilDateIn(now, timeZone) > validUntil;
}
