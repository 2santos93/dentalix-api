import type { Sex } from '@prisma/client';
import { PARTIAL_SUPPRESSION_FIELDS } from '../../patients/domain/ports/patient-repository.port';
import {
  FILLABLE_FIELDS,
  type FillableField,
  type ImportPatientData,
} from './import-fields';

/** Lo que importa de un paciente existente para «Actualizar solo campos vacíos». */
export interface FillablePatient {
  birthDate: Date | null;
  sex: Sex;
  phone: string | null;
  email: string | null;
  address: string | null;
  occupation: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  notes: string | null;
  /** Supresión parcial (Ley 1581, DX-039): sus campos no se vuelven a rellenar. */
  partiallySuppressedAt?: Date | null;
}

const SUPPRESSED = new Set<string>(PARTIAL_SUPPRESSION_FIELDS);

/** Lo rellenado: campo → valor en texto (la fecha, AAAA-MM-DD). */
export type FilledValues = Partial<Record<FillableField, string>>;

function current(
  patient: FillablePatient,
  field: FillableField,
): string | null {
  if (field === 'birthDate') {
    return patient.birthDate
      ? patient.birthDate.toISOString().slice(0, 10)
      : null;
  }
  if (field === 'sex')
    return patient.sex === 'UNSPECIFIED' ? null : patient.sex;
  const value = patient[field];
  return value === null || value.trim() === '' ? null : value;
}

/**
 * Qué campos VACÍOS del paciente existente rellena la fila. Nunca pisa un
 * dato: un campo con algo escrito (o un sexo distinto de «sin especificar»)
 * se queda como está aunque el fichero traiga otro valor. Si el paciente
 * pidió la supresión parcial de sus datos (Ley 1581), los campos suprimidos
 * (teléfono, correo, dirección, notas, contacto de emergencia) NO se
 * rellenan aunque estén vacíos: es justo lo que la supresión impide.
 */
export function fillEmpty(
  patient: FillablePatient,
  data: ImportPatientData,
): FilledValues {
  const filled: FilledValues = {};
  for (const field of FILLABLE_FIELDS) {
    const incoming = data[field];
    if (incoming === undefined) continue;
    if (patient.partiallySuppressedAt && SUPPRESSED.has(field)) continue;
    if (current(patient, field) === null) filled[field] = incoming;
  }
  return filled;
}

/**
 * Al deshacer: los campos rellenados por el lote que SIGUEN con el valor que
 * puso el lote (si alguien los cambió después, se respeta su cambio).
 */
export function fieldsToRevert(
  patient: FillablePatient,
  filled: FilledValues,
): FillableField[] {
  return FILLABLE_FIELDS.filter(
    (field) =>
      filled[field] !== undefined && current(patient, field) === filled[field],
  );
}
