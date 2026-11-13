import { civilDateIn, isValidTimeZone } from '../../../shared/time/civil-day';

/**
 * DX-467: lo que la página PÚBLICA de una receta dice de ella. Lo mínimo para
 * que una farmacia (o el paciente) sepa si vale, y nada clínico: ni
 * medicamentos, ni diagnóstico, ni documento del paciente, ni el motivo de la
 * anulación.
 *
 * - `UNVERIFIABLE`: el hash guardado no casa con el recalculado. Gana a todo
 *   (también a «anulada»): si el contenido pudo alterarse, no se afirma nada.
 * - `VOIDED`: solo el día de la anulación.
 * - `VALID`: día de emisión, profesional y su registro, clínica e iniciales
 *   del paciente.
 *
 * Los días son civiles (`YYYY-MM-DD`) en la zona de la sede de la receta;
 * `null` si la sede no tiene una zona válida (nunca una zona de reserva,
 * GLOBAL-G1). `locale` es el de la sede, para que la web los escriba como allí
 * se escriben (DD/MM/AAAA en Venezuela).
 */
export type PrescriptionVerification =
  | {
      status: 'VALID';
      issuedOn: string | null;
      professionalName: string;
      professionalLicense: string;
      clinicName: string;
      patientInitials: string;
      locale: string | null;
    }
  | { status: 'VOIDED'; voidedOn: string | null; locale: string | null }
  | { status: 'UNVERIFIABLE' };

/** Lo que la verificación lee de una receta guardada. */
export interface VerifiablePrescription {
  status: 'ISSUED' | 'VOIDED';
  issuedAt: Date;
  voidedAt: Date | null;
  professionalName: string;
  professionalLicense: string;
  clinicName: string;
  patientName: string;
  locationFormat: { timeZone: string | null; locale: string | null };
}

/** Partículas de los apellidos que no dan inicial («de la Rosa» → R). */
const PARTICLES = new Set([
  'de',
  'del',
  'la',
  'las',
  'los',
  'y',
  'da',
  'do',
  'dos',
  'das',
  'van',
  'von',
  'di',
]);
const MAX_INITIALS = 4;

/**
 * Iniciales del nombre congelado en la receta: «María José Pérez de la Rosa»
 * → «M. J. P. R.». Hasta 4, sin partículas; letras de cualquier alfabeto.
 */
export function patientInitials(fullName: string): string {
  const initials = fullName
    .split(/\s+/)
    .filter(
      (word) => word !== '' && !PARTICLES.has(word.toLocaleLowerCase('es')),
    )
    .map((word) => [...word].find((ch) => /\p{L}/u.test(ch)))
    .filter((ch): ch is string => ch !== undefined)
    .slice(0, MAX_INITIALS)
    .map((ch) => `${ch.toLocaleUpperCase('es')}.`);
  return initials.join(' ');
}

function civilDayOrNull(
  instant: Date | null,
  timeZone: string | null,
): string | null {
  if (!instant || !timeZone || !isValidTimeZone(timeZone)) return null;
  return civilDateIn(instant, timeZone);
}

export function verifyPrescription(
  rx: VerifiablePrescription,
  integrityOk: boolean,
): PrescriptionVerification {
  if (!integrityOk) return { status: 'UNVERIFIABLE' };
  const { timeZone, locale } = rx.locationFormat;
  if (rx.status === 'VOIDED') {
    return {
      status: 'VOIDED',
      voidedOn: civilDayOrNull(rx.voidedAt, timeZone),
      locale,
    };
  }
  return {
    status: 'VALID',
    issuedOn: civilDayOrNull(rx.issuedAt, timeZone),
    professionalName: rx.professionalName,
    professionalLicense: rx.professionalLicense,
    clinicName: rx.clinicName,
    patientInitials: patientInitials(rx.patientName),
    locale,
  };
}
