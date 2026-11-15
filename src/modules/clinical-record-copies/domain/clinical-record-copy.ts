import { checkPeriodDays } from '../../../shared/time/civil-day';
import {
  AUDIT_RECORD_COPY_SECTIONS,
  type AuditRecordCopySection,
} from '../../audit/domain/audit-metadata';

/**
 * DX-456: «Copia de la historia clínica» de un paciente. Una generación elige
 * un período (días civiles de la sede, ambos inclusive) y las secciones; el
 * documento solo lleva lo que cae en ese período.
 *
 * Las secciones son las mismas (y en el mismo orden) que los códigos que la
 * auditoría admite: un código nuevo se añade en los dos sitios o el saneador
 * lo descarta.
 */
export const CLINICAL_RECORD_COPY_SECTIONS = AUDIT_RECORD_COPY_SECTIONS;
export type ClinicalRecordCopySection = AuditRecordCopySection;

/** Tope de «entregado a»: un nombre y, si acaso, el parentesco. */
export const DELIVERED_TO_MAX = 120;

export const CLINICAL_RECORD_COPY_MESSAGES = {
  invalidPeriod:
    'El período no es válido: indica dos fechas reales y que «desde» no sea posterior a «hasta».',
  periodOutOfRange:
    'Las fechas del período tienen que estar entre el 01/01/2000 y el 31/12/2100.',
  futurePeriod:
    'El período no puede empezar después de hoy en la sede de la copia.',
  noSections: 'Elige al menos una sección para la copia.',
  unknownSection: 'Alguna sección de la copia no existe.',
  repeatedSection: 'Una sección aparece más de una vez.',
  deliveredToTooLong: `«Entregado a» admite hasta ${DELIVERED_TO_MAX} caracteres.`,
  deliveredToLines: '«Entregado a» tiene que ir en una sola línea.',
  copyNotFound: 'No encontramos esa copia de la historia clínica.',
} as const;

export interface CopyRequestInput {
  from: string;
  to: string;
  sections: readonly string[];
  deliveredTo?: string | null;
}

export interface ValidCopyRequest {
  from: string;
  to: string;
  /** Sin repetir y en el orden canónico del documento. */
  sections: ClinicalRecordCopySection[];
  /** Recortado; null si no se indicó o quedó vacío. */
  deliveredTo: string | null;
}

export type CopyRequestCheck =
  { ok: true; value: ValidCopyRequest } | { ok: false; message: string };

// Caracteres de control (incluidos los saltos de línea y el tabulador).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * ÚNICA validación de una petición de copia. El día de hoy (`today`, día civil
 * en la zona de la sede) acota el comienzo: un período entero en el futuro no
 * tiene registros. «Hasta» sí puede ser futuro: las citas agendadas cuentan.
 */
export function checkCopyRequest(
  input: CopyRequestInput,
  today: string,
): CopyRequestCheck {
  const period = checkPeriodDays(input.from, input.to);
  if (!period.ok) {
    return {
      ok: false,
      message:
        period.problem === 'OUT_OF_RANGE'
          ? CLINICAL_RECORD_COPY_MESSAGES.periodOutOfRange
          : CLINICAL_RECORD_COPY_MESSAGES.invalidPeriod,
    };
  }
  if (period.from > today) {
    return { ok: false, message: CLINICAL_RECORD_COPY_MESSAGES.futurePeriod };
  }
  if (input.sections.length === 0) {
    return { ok: false, message: CLINICAL_RECORD_COPY_MESSAGES.noSections };
  }
  if (new Set(input.sections).size !== input.sections.length) {
    return {
      ok: false,
      message: CLINICAL_RECORD_COPY_MESSAGES.repeatedSection,
    };
  }
  const known = new Set<string>(CLINICAL_RECORD_COPY_SECTIONS);
  if (input.sections.some((s) => !known.has(s))) {
    return { ok: false, message: CLINICAL_RECORD_COPY_MESSAGES.unknownSection };
  }
  const deliveredTo = input.deliveredTo?.trim() || null;
  if (deliveredTo !== null) {
    if (CONTROL.test(deliveredTo)) {
      return {
        ok: false,
        message: CLINICAL_RECORD_COPY_MESSAGES.deliveredToLines,
      };
    }
    if (deliveredTo.length > DELIVERED_TO_MAX) {
      return {
        ok: false,
        message: CLINICAL_RECORD_COPY_MESSAGES.deliveredToTooLong,
      };
    }
  }
  return {
    ok: true,
    value: {
      from: period.from,
      to: period.to,
      sections: CLINICAL_RECORD_COPY_SECTIONS.filter((s) =>
        input.sections.includes(s),
      ),
      deliveredTo,
    },
  };
}

/** Una generación tal y como la lista la ficha (sin contenido clínico). */
export interface ClinicalRecordCopySummary {
  id: string;
  from: string;
  to: string;
  sections: ClinicalRecordCopySection[];
  deliveredTo: string | null;
  generatedAt: Date;
  generatedBy: { id: string; name: string | null };
  location: { id: string; name: string };
}
