import { addCivilDays } from '../../../shared/time/civil-day';
import {
  Problems,
  civilDay,
  text,
} from '../../equipment/domain/equipment-rules';
import { addCivilMonths } from '../../recall/domain/recall-rules';
import type {
  RadiologyLicenseCategory,
  RadiologyRecordKind,
  RadiologyStatus,
} from './entities/radiology-record.entity';

/**
 * DX-544 · Reglas del expediente de rayos X de una sede. Es la única
 * definición: los casos de uso la llaman y la BD repite los topes con CHECK.
 *
 * Vigencias por defecto: licencia de Categoría I (periapical) 5 años, de
 * Categoría II (panorámica, tomografía oral) 4 años; informe de control de
 * calidad de un tercero, 2 años (los plazos del requisito que motivó DX-544,
 * ver loop/informes/DX-544.md). Son solo el valor propuesto cuando no se
 * escribe la fecha de vencimiento: quien registra el documento pone la que
 * dice el papel si es otra.
 */
export const RADIOLOGY_VALIDITY_MONTHS: Record<
  `LICENSE_${RadiologyLicenseCategory}` | 'QUALITY_CONTROL',
  number
> = {
  LICENSE_I: 60,
  LICENSE_II: 48,
  QUALITY_CONTROL: 24,
};

/**
 * El aviso empieza 90 días naturales antes del vencimiento: la renovación de
 * la licencia se pide 60 días HÁBILES antes, que son unos 85–90 naturales.
 */
export const RADIOLOGY_DUE_SOON_DAYS = 90;
/** Tope del vencimiento explícito: 10 años después de la expedición. */
export const RADIOLOGY_EXPIRY_MAX_MONTHS = 120;

export const RADIOLOGY_REFERENCE_MAX = 80;
export const RADIOLOGY_ISSUER_MAX = 120;
export const RADIOLOGY_OFFICER_MAX = 120;
export const RADIOLOGY_NOTES_MAX = 2000;

export const RADIOLOGY_RECORD_NOT_FOUND_MESSAGE =
  'Documento de rayos X no encontrado';
export const RADIOLOGY_LOCATION_NOT_FOUND_MESSAGE = 'Sede no encontrada';
export const RADIOLOGY_LOCATION_NO_ZONE_MESSAGE =
  'La sede no tiene zona horaria configurada: configúrala antes de registrar documentos de rayos X.';
export const RADIOLOGY_EQUIPMENT_NOT_FOUND_MESSAGE = 'Equipo no encontrado';
export const RADIOLOGY_EQUIPMENT_OTHER_LOCATION_MESSAGE =
  'El equipo no es de la sede del documento.';
export const RADIOLOGY_EQUIPMENT_NOT_XRAY_MESSAGE =
  'El equipo no es de rayos X: elige uno de tipo «Rayos X» o ninguno.';
export const RADIOLOGY_EQUIPMENT_RETIRED_MESSAGE =
  'El equipo está dado de baja: elige otro o ninguno.';
export const RADIOLOGY_OFFICER_NOT_FOUND_MESSAGE =
  'Miembro del personal no encontrado';
export const RADIOLOGY_OFFICER_BOTH_MESSAGE =
  'Elige un miembro del personal o escribe el nombre del encargado, no los dos.';
export const RADIOLOGY_VOIDED_MESSAGE =
  'El documento está anulado: ya no se edita.';
export const RADIOLOGY_ALREADY_VOIDED_MESSAGE = 'El documento ya está anulado.';

export interface RadiologyFieldsInput {
  kind: RadiologyRecordKind;
  category?: RadiologyLicenseCategory | null;
  reference?: string | null;
  issuer?: string | null;
  issuedOn?: string | null;
  /** `null`/vacío: se calcula por el tipo y la categoría. */
  expiresOn?: string | null;
  officerName?: string | null;
  notes?: string | null;
}

export interface RadiologyFields {
  kind: RadiologyRecordKind;
  category: RadiologyLicenseCategory | null;
  reference: string | null;
  issuer: string;
  issuedOn: string;
  expiresOn: string;
  officerName: string | null;
  notes: string | null;
}

/**
 * Vencimiento por defecto: la expedición + la vigencia del tipo (y de la
 * categoría en una licencia). Recorta a fin de mes (29/2 + 5 años → 28/2).
 */
export function defaultExpiresOn(
  kind: RadiologyRecordKind,
  category: RadiologyLicenseCategory | null,
  issuedOn: string,
): string {
  const months =
    kind === 'QUALITY_CONTROL'
      ? RADIOLOGY_VALIDITY_MONTHS.QUALITY_CONTROL
      : RADIOLOGY_VALIDITY_MONTHS[`LICENSE_${category ?? 'I'}`];
  return addCivilMonths(issuedOn, months);
}

/**
 * Valida y normaliza un documento COMPLETO (el alta, o la edición ya
 * mezclada con lo guardado). `today` es el día de la sede: la expedición no
 * es futura. Todos los errores salen juntos en un 400.
 */
export function validateRadiologyFields(
  input: RadiologyFieldsInput,
  today: string,
): RadiologyFields {
  const problems = new Problems();
  const isLicense = input.kind === 'LICENSE';
  const category = input.category ?? null;
  if (isLicense && category === null) {
    problems.add('Indica la categoría de la licencia (I o II).');
  } else if (!isLicense && category !== null) {
    problems.add('La categoría solo va en una licencia.');
  }
  const reference = text(
    input.reference,
    {
      label: 'El número o la resolución',
      max: RADIOLOGY_REFERENCE_MAX,
      requiredMessage: isLicense
        ? `Escribe el número o la resolución de la licencia (hasta ${RADIOLOGY_REFERENCE_MAX} caracteres).`
        : undefined,
    },
    problems,
  );
  const issuer = text(
    input.issuer,
    {
      label: 'La entidad emisora',
      max: RADIOLOGY_ISSUER_MAX,
      requiredMessage: isLicense
        ? `Escribe la autoridad que expidió la licencia (hasta ${RADIOLOGY_ISSUER_MAX} caracteres).`
        : `Escribe la empresa que hizo el control de calidad (hasta ${RADIOLOGY_ISSUER_MAX} caracteres).`,
    },
    problems,
  );
  const issuedOn = civilDay(
    input.issuedOn ?? '0000-00-00',
    'de expedición',
    problems,
    today,
  );
  const explicit = civilDay(input.expiresOn, 'de vencimiento', problems);
  if (explicit !== null && issuedOn !== null) {
    if (explicit <= issuedOn) {
      problems.add('El vencimiento tiene que ser posterior a la expedición.');
    } else if (
      explicit > addCivilMonths(issuedOn, RADIOLOGY_EXPIRY_MAX_MONTHS)
    ) {
      problems.add(
        'El vencimiento no puede ser a más de 10 años de la expedición.',
      );
    }
  }
  const officerName = text(
    input.officerName,
    {
      label: 'El nombre del encargado',
      max: RADIOLOGY_OFFICER_MAX,
    },
    problems,
  );
  const notes = text(
    input.notes,
    { label: 'El campo de notas', max: RADIOLOGY_NOTES_MAX, multiline: true },
    problems,
  );
  problems.throwIfAny();
  return {
    kind: input.kind,
    category,
    reference,
    issuer: issuer!,
    issuedOn: issuedOn!,
    expiresOn: explicit ?? defaultExpiresOn(input.kind, category, issuedOn!),
    officerName,
    notes,
  };
}

/**
 * En el día de la sede: renovado (hay otro vivo que vence después), vencido
 * (antes de hoy), vence pronto (hoy a +90 días) o al día.
 */
export function radiologyStatus(
  expiresOn: string,
  today: string,
  renewed: boolean,
): RadiologyStatus {
  if (renewed) return 'RENEWED';
  if (expiresOn < today) return 'OVERDUE';
  if (expiresOn <= addCivilDays(today, RADIOLOGY_DUE_SOON_DAYS)) {
    return 'DUE_SOON';
  }
  return 'UP_TO_DATE';
}
