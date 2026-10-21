import { civilDateIn, parseCivilDate } from '../../../shared/time/civil-day';

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
 * `day` (YYYY-MM-DD) más `months` meses de calendario (negativo resta). Si el
 * día no existe en el mes de destino (31 de enero + 1 mes, 29 de febrero + 12
 * meses), queda en el último día de ese mes.
 */
export function addCivilMonths(day: string, months: number): string {
  if (parseCivilDate(day) === null) {
    throw new RangeError(`Invalid civil date: ${day}`);
  }
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(target.getUTCFullYear(), 4)}-${pad(target.getUTCMonth() + 1)}-${pad(Math.min(d, lastDay))}`;
}

/**
 * Primer día civil (en la zona de la sede) en que una anamnesis revisada en
 * `reviewedAt` ya no vale: el día de la revisión allí más la vigencia.
 */
export function anamnesisExpiresOn(
  reviewedAt: Date,
  months: number,
  timeZone: string,
): string {
  return addCivilMonths(civilDateIn(reviewedAt, timeZone), months);
}

/**
 * Estado de la anamnesis el día civil `asOf` (YYYY-MM-DD) de la sede:
 * `MISSING` si nunca se registró; `EXPIRED` desde el día en que se cumple la
 * vigencia (todo ese día, no desde la hora de la revisión); `CURRENT` antes.
 * La agenda lo evalúa con el día de CADA cita: preparar la visita del jueves
 * debe ver lo que valdrá el jueves.
 */
export function anamnesisStatus(
  lastReviewedAt: Date | null,
  validityMonths: number,
  asOf: string,
  timeZone: string,
): AnamnesisStatus {
  if (!lastReviewedAt) return 'MISSING';
  return asOf >= anamnesisExpiresOn(lastReviewedAt, validityMonths, timeZone)
    ? 'EXPIRED'
    : 'CURRENT';
}
