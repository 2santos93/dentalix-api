import { ClinicCountry } from '@prisma/client';

/**
 * Reglas legales de la receta por país (DX-013).
 *
 * - CO (Dec. 780/2016, art. 2.5.3.10.16): por medicamento, DCI, concentración,
 *   forma farmacéutica, vía, dosis, frecuencia, duración y cantidad total (que
 *   se imprime también en letras); nº de historia clínica del paciente y
 *   registro profesional del prescriptor.
 * - ES (RD 1718/2010, art. 3): lo anterior más nº de envases, DNI/NIE y año de
 *   nacimiento del paciente y nº de colegiado; una receta por medicamento y
 *   validez de 10 días naturales desde la fecha prevista de dispensación.
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

export interface PrescriptionPatientFacts {
  docNumber: string | null;
  birthDate: Date | null;
}

export interface PrescriptionValidationInput {
  items: readonly PrescriptionItemInput[];
  patient: PrescriptionPatientFacts;
  professionalLicense: string | null | undefined;
}

export const MAX_PRESCRIPTION_ITEMS = 10;

/** Días naturales de validez, contando el día de inicio. */
export const PRESCRIPTION_VALIDITY_DAYS: Record<ClinicCountry, number> = {
  // Dec. 780 exige indicar la vigencia sin fijar el plazo: convención de 30 días.
  CO: 30,
  // RD 1718/2010: 10 días naturales desde la fecha prevista de dispensación.
  ES: 10,
};

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

function itemErrors(
  country: ClinicCountry,
  item: PrescriptionItemInput,
  n: number,
): string[] {
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
  if (item.packages == null) {
    if (country === ClinicCountry.ES) missing('el número de envases');
  } else if (!intInRange(item.packages, 1, 99)) {
    errors.push(
      `Medicamento ${n}: el número de envases debe ser un entero entre 1 y 99`,
    );
  }
  return errors;
}

export function validatePrescription(
  country: ClinicCountry,
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
  if (country === ClinicCountry.ES && input.items.length > 1) {
    return [
      'En España cada receta lleva un solo medicamento: emite una receta por medicamento',
    ];
  }

  const errors = input.items.flatMap((item, i) =>
    itemErrors(country, item, i + 1),
  );

  const { docNumber, birthDate } = input.patient;
  if (country === ClinicCountry.CO) {
    if (blank(docNumber)) {
      errors.push(
        'Falta el número de historia clínica: registra el documento del paciente en sus datos',
      );
    }
    if (blank(input.professionalLicense)) {
      errors.push('Falta tu registro profesional');
    }
  } else {
    if (blank(docNumber)) {
      errors.push('Falta el DNI/NIE del paciente: regístralo en sus datos');
    }
    if (!birthDate) {
      errors.push(
        'Falta el año de nacimiento del paciente: registra su fecha de nacimiento',
      );
    }
    if (blank(input.professionalLicense)) {
      errors.push('Falta tu número de colegiado');
    }
  }
  return errors;
}

/** `YYYY-MM-DD` + (validez − 1) días: el último día en que la receta vale. */
export function computeValidUntil(
  country: ClinicCountry,
  startDate: string,
): string {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  start.setUTCDate(
    start.getUTCDate() + PRESCRIPTION_VALIDITY_DAYS[country] - 1,
  );
  return start.toISOString().slice(0, 10);
}
