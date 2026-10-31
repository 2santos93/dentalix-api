import { PEDIATRIC_AGE_LIMIT } from '../../prescriptions/domain/prescription-safety';

/**
 * Límites de la anestesia local que dependen del PACIENTE (DX-420): máximo
 * pediátrico, edad mínima del fármaco, reducción en lactantes y con sedación
 * y tope de epinefrina por cita. Los valores por fármaco (mg/kg pediátrico,
 * edad mínima, mg de epinefrina por carpule) son DATOS del catálogo de la
 * clínica; aquí solo las reglas y los umbrales de la guía.
 *
 * Fuentes (Matriz 99 de la investigación):
 *  - AAPD, «Use of Local Anesthesia for Pediatric Dental Patients» (revisión
 *    2023, Reference Manual 2025): lidocaína y mepivacaína 4,4 mg/kg en
 *    niños; articaína no recomendada en menores de 4 años y bupivacaína en
 *    menores de 12; −30 % en menores de 6 meses y con otros depresores del
 *    SNC (sedación).
 *  - Malamed, Handbook of Local Anesthesia: epinefrina máx. 0,2 mg por cita
 *    en el adulto sano y 0,04 mg en el cardiópata (≈ 2 carpules 1:100.000).
 *
 * «Pediátrico» = menor de 12 años cumplidos (`PEDIATRIC_AGE_LIMIT`, el mismo
 * corte que ya pide el peso en la anestesia y en la receta, y la edad desde
 * la que la AAPD admite bupivacaína).
 */
export { PEDIATRIC_AGE_LIMIT };

/** Por debajo de estos meses cumplidos, −30 % (AAPD). */
export const INFANT_MONTHS_LIMIT = 6;
/** Reducción del máximo por cada causa (lactante, depresor del SNC). */
export const DOSE_REDUCTION_FRACTION = 0.3;
/** Epinefrina por cita en mg: adulto sano y cardiópata. */
export const EPINEPHRINE_MAX_MG = 0.2;
export const EPINEPHRINE_CARDIAC_MAX_MG = 0.04;

/**
 * Condiciones de la anamnesis (mismos `codigo` que el cuestionario y el
 * checklist del personal, DX-099/DX-247) que bajan el tope de epinefrina:
 * enfermedad cardíaca, hipertensión y valvulopatía o prótesis valvular.
 */
export const CARDIAC_CONDITION_CODES: readonly string[] = [
  'CARDIOPATIA',
  'HIPERTENSION',
  'VALVULOPATIA',
  'PROTESIS_VALVULAR',
];

export const AAPD_SOURCE =
  'AAPD, Use of Local Anesthesia for Pediatric Dental Patients (revisión 2023)';
export const EPINEPHRINE_SOURCE =
  'Malamed, Handbook of Local Anesthesia: epinefrina máx. 0,2 mg por cita (adulto sano) y 0,04 mg (cardiópata)';

/** Lo que el cálculo sabe del paciente. */
export interface DosePatient {
  /** Años cumplidos; null sin fecha de nacimiento. */
  ageYears: number | null;
  /** Meses cumplidos; null sin fecha de nacimiento. */
  ageMonths: number | null;
  /** Hoja de sedación (DX-407) en las 24 h de la administración. */
  sedation: boolean;
  /** Cardiopatía en la anamnesis; null sin anamnesis. */
  cardiac: boolean | null;
}

export const UNKNOWN_PATIENT: DosePatient = {
  ageYears: null,
  ageMonths: null,
  sedation: false,
  cardiac: null,
};

/** Qué ajustes del máximo aplican y el multiplicador resultante. */
export interface DoseAdjustment {
  pediatric: boolean;
  infant: boolean;
  sedation: boolean;
  /** 1 = sin reducción; 0,7 con una causa; 0,49 con las dos. */
  factor: number;
}

export const NO_ADJUSTMENT: DoseAdjustment = {
  pediatric: false,
  infant: false,
  sedation: false,
  factor: 1,
};

/**
 * Sin fecha de nacimiento no se presume menor ni lactante (se avisa aparte).
 * Las dos reducciones se MULTIPLICAN: la guía no dice cómo combinarlas y
 * multiplicar es lo prudente (un lactante sedado es un caso excepcional).
 */
export function doseAdjustment(patient: DosePatient): DoseAdjustment {
  const pediatric =
    patient.ageYears !== null && patient.ageYears < PEDIATRIC_AGE_LIMIT;
  const infant =
    patient.ageMonths !== null && patient.ageMonths < INFANT_MONTHS_LIMIT;
  const keep = 1 - DOSE_REDUCTION_FRACTION;
  const factor = (infant ? keep : 1) * (patient.sedation ? keep : 1);
  return { pediatric, infant, sedation: patient.sedation, factor };
}

/**
 * Meses cumplidos el día civil `today` (AAAA-MM-DD) de la sede; null sin
 * fecha de nacimiento o si aún no ha nacido ese día.
 */
export function ageInMonths(
  birthDate: Date | null,
  today: string,
): number | null {
  if (birthDate === null) return null;
  const [y, m, d] = today.split('-').map(Number);
  const months =
    (y - birthDate.getUTCFullYear()) * 12 +
    (m - 1 - birthDate.getUTCMonth()) -
    (d < birthDate.getUTCDate() ? 1 : 0);
  return Number.isInteger(months) && months >= 0 ? months : null;
}

const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * mg de epinefrina por carpule a partir del texto del vasoconstrictor:
 * 1:N son 1 g en N ml → 1000 / N mg/ml × ml del carpule (1:100.000 →
 * 0,01 mg/ml; 1,8 ml → 0,018 mg). Sin vasoconstrictor u otro distinto de la
 * epinefrina (felipresina, noradrenalina) → 0. Epinefrina sin dilución
 * legible, o que daría más de 0,2 mg por carpule → null: la clínica debe
 * anotarla en el catálogo.
 */
export function epinephrineFromLabel(
  vasoconstrictor: string | null,
  mlPerCarpule: number,
): number | null {
  if (vasoconstrictor === null) return 0;
  const text = norm(vasoconstrictor);
  if (!/(^|[^r])(epinef|adrenal)/.test(text)) return 0;
  const match = /1\s*:\s*(\d{1,3}(?:[.\s]\d{3})+|\d+)/.exec(text);
  const dilution = match ? Number(match[1].replace(/[.\s]/g, '')) : NaN;
  if (!Number.isFinite(dilution) || dilution <= 0) return null;
  const mg = Math.round(((mlPerCarpule * 1000) / dilution) * 10000) / 10000;
  // Más de un tope de adulto en un solo carpule no es una dilución real
  // (p. ej. «1:1000» por error): no se sabe, como sin dilución. Además el
  // CHECK de la tabla no admite más de 0,2 mg (la migración usa el mismo corte).
  return mg > EPINEPHRINE_MAX_MG ? null : mg;
}

export function epinephrineMaxMg(cardiac: boolean | null): number {
  return cardiac === true ? EPINEPHRINE_CARDIAC_MAX_MG : EPINEPHRINE_MAX_MG;
}

export function hasCardiacCondition(
  conditions: readonly { codigo: string; estado: string }[],
): boolean {
  return conditions.some(
    (c) => c.estado === 'SI' && CARDIAC_CONDITION_CODES.includes(c.codigo),
  );
}
