import { addCivilDays } from '../../../shared/time/civil-day';

/**
 * Reglas de la receta única (DX-324, spec R2–R4), iguales en toda clínica y
 * sede:
 * - por medicamento, principio activo, concentración, forma farmacéutica, vía,
 *   dosis, frecuencia, duración (1–365), cantidad total (1–9999) y su unidad;
 *   los envases son opcionales (1–99);
 * - de 1 a `MAX_PRESCRIPTION_ITEMS` medicamentos;
 * - el nº de registro profesional de quien prescribe;
 * - el documento del paciente, solo si la clínica exige el nº de historia
 *   clínica.
 *
 * Devuelve TODOS los fallos (en español, listos para el 400), no solo el
 * primero, para que el profesional los corrija de una vez.
 */

export interface PrescriptionItemInput {
  activeIngredient?: string | null;
  brandName?: string | null;
  concentration?: string | null;
  pharmaceuticalForm?: string | null;
  route?: string | null;
  dose?: string | null;
  frequency?: string | null;
  durationDays?: number | null;
  totalQuantity?: number | null;
  quantityUnit?: string | null;
  packages?: number | null;
  instructions?: string | null;
}

export interface PrescriptionValidationInput {
  items: readonly PrescriptionItemInput[];
  patient: { docNumber: string | null };
  professionalLicense: string | null | undefined;
  /** Ajuste de la clínica: exige el documento del paciente (nº de HC). */
  requireClinicalRecordNumber: boolean;
}

export const MAX_PRESCRIPTION_ITEMS = 10;

const TEXT_FIELDS: readonly [keyof PrescriptionItemInput, string][] = [
  ['activeIngredient', 'el principio activo (DCI)'],
  ['concentration', 'la concentración'],
  ['pharmaceuticalForm', 'la forma farmacéutica'],
  ['route', 'la vía de administración'],
  ['dose', 'la dosis'],
  ['frequency', 'la frecuencia'],
];

function blank(value: string | null | undefined): boolean {
  return (value ?? '').trim() === '';
}

function intInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function itemErrors(item: PrescriptionItemInput, n: number): string[] {
  const errors: string[] = [];
  const missing = (what: string) =>
    errors.push(`Medicamento ${n}: falta ${what}`);
  for (const [field, label] of TEXT_FIELDS) {
    if (blank(item[field] as string | null | undefined)) missing(label);
  }
  if (item.durationDays == null) {
    missing('la duración del tratamiento (días)');
  } else if (!intInRange(item.durationDays, 1, 365)) {
    errors.push(
      `Medicamento ${n}: la duración debe ser un número entero de días entre 1 y 365`,
    );
  }
  if (item.totalQuantity == null) {
    missing('la cantidad total');
  } else if (!intInRange(item.totalQuantity, 1, 9999)) {
    errors.push(
      `Medicamento ${n}: la cantidad total debe ser un número entero entre 1 y 9999`,
    );
  }
  if (blank(item.quantityUnit)) {
    missing('la unidad de la cantidad (p. ej. tabletas)');
  }
  if (item.packages != null && !intInRange(item.packages, 1, 99)) {
    errors.push(
      `Medicamento ${n}: el número de envases debe ser un entero entre 1 y 99`,
    );
  }
  return errors;
}

export function validatePrescription(
  input: PrescriptionValidationInput,
): string[] {
  if (input.items.length === 0) {
    return ['La receta necesita al menos un medicamento'];
  }
  if (input.items.length > MAX_PRESCRIPTION_ITEMS) {
    return [
      `Una receta admite como mucho ${MAX_PRESCRIPTION_ITEMS} medicamentos`,
    ];
  }

  const errors = input.items.flatMap((item, i) => itemErrors(item, i + 1));
  if (input.requireClinicalRecordNumber && blank(input.patient.docNumber)) {
    errors.push(
      'Falta el número de historia clínica: registra el documento del paciente en sus datos',
    );
  }
  if (blank(input.professionalLicense)) {
    errors.push('Falta tu número de registro profesional');
  }
  return errors;
}

/**
 * `YYYY-MM-DD` + (validez − 1) días civiles: el último día en que la receta
 * vale, contando el de inicio (spec R6).
 */
export function computeValidUntil(
  startDate: string,
  validityDays: number,
): string {
  return addCivilDays(startDate, validityDays - 1);
}
