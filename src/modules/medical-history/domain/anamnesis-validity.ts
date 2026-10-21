/**
 * Vigencia de la anamnesis (DX-247). La AAOM pide la historia completa al
 * menos una vez al año; la ADA, preguntar en cada visita si algo cambió. Cada
 * clínica fija cuántos meses vale (`tenants.anamnesisValidityMonths`); pasado
 * ese plazo desde la última versión o la última confirmación «Sin cambios
 * hoy», la agenda y la ficha la muestran como caducada.
 */
export type AnamnesisStatus = 'CURRENT' | 'EXPIRED' | 'MISSING';

export const ANAMNESIS_STATUSES: readonly AnamnesisStatus[] = [
  'CURRENT',
  'EXPIRED',
  'MISSING',
];

export const DEFAULT_ANAMNESIS_VALIDITY_MONTHS = 12;
export const ANAMNESIS_VALIDITY_MIN_MONTHS = 1;
export const ANAMNESIS_VALIDITY_MAX_MONTHS = 60;

export const ANAMNESIS_VALIDITY_MESSAGE = `La vigencia de la anamnesis va de ${ANAMNESIS_VALIDITY_MIN_MONTHS} a ${ANAMNESIS_VALIDITY_MAX_MONTHS} meses.`;

export function isValidAnamnesisValidity(months: number): boolean {
  return (
    Number.isInteger(months) &&
    months >= ANAMNESIS_VALIDITY_MIN_MONTHS &&
    months <= ANAMNESIS_VALIDITY_MAX_MONTHS
  );
}

/**
 * Suma meses de calendario (UTC) conservando la hora. Si el día no existe en
 * el mes de destino (31 de enero + 1 mes), queda en el último día de ese mes.
 */
export function addMonthsUtc(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = new Date(date.getTime());
  result.setUTCFullYear(year, month, Math.min(date.getUTCDate(), lastDay));
  return result;
}

/** Primer instante en que una anamnesis revisada en `reviewedAt` deja de valer. */
export function anamnesisExpiresAt(reviewedAt: Date, months: number): Date {
  return addMonthsUtc(reviewedAt, months);
}

/**
 * `MISSING` si nunca se registró; `EXPIRED` desde el instante en que se
 * cumple la vigencia; `CURRENT` antes. Se compara en instantes: a 12 meses, la
 * zona de la sede mueve el corte unas horas, no un día de consulta.
 */
export function anamnesisStatus(
  lastReviewedAt: Date | null,
  validityMonths: number,
  now: Date,
): AnamnesisStatus {
  if (!lastReviewedAt) return 'MISSING';
  return now.getTime() >=
    anamnesisExpiresAt(lastReviewedAt, validityMonths).getTime()
    ? 'EXPIRED'
    : 'CURRENT';
}
