import { ageInYears } from './prescription-safety';

/**
 * Edad y peso que congela la foto de la receta (DX-324, spec R8). Una fecha de
 * nacimiento o un peso imposibles nunca impiden emitir: la foto guarda `null`
 * y el CHECK de la tabla no salta (pre-flight I1, M3).
 */
const MAX_SNAPSHOT_AGE = 150;
const MAX_SNAPSHOT_WEIGHT_KG = 400;

/**
 * Años cumplidos el día civil `today` de la sede, o `null` sin fecha de
 * nacimiento o fuera de 0–150 (fecha futura, errata de siglo, o un recién
 * nacido cuyo día aún no ha llegado en la zona de la sede).
 */
export function ageForSnapshot(
  birthDate: Date | null,
  today: string,
): number | null {
  if (birthDate === null) return null;
  const age = ageInYears(birthDate, today);
  return Number.isInteger(age) && age >= 0 && age <= MAX_SNAPSHOT_AGE
    ? age
    : null;
}

/**
 * Peso de la foto, redondeado a 0,1 kg ANTES de sellar, sobre el valor binario
 * exacto: 72,55 es en realidad 72,5499… (×10 = 725,4999…), así que queda en
 * 72,5, y así se guarda y se sella. `Math.round(kg * 10)` daría 72,6, porque
 * la multiplicación ya redondea a 725,5.
 */
export function roundWeightKg(kg: number): number {
  return Number(kg.toFixed(1));
}

/** Peso redondeado a 0,1 kg, o `null` si el redondeo queda fuera de `0 < w < 400`. */
export function weightForSnapshot(kg: number | null): number | null {
  if (kg === null || !Number.isFinite(kg)) return null;
  const rounded = roundWeightKg(kg);
  return rounded > 0 && rounded < MAX_SNAPSHOT_WEIGHT_KG ? rounded : null;
}
