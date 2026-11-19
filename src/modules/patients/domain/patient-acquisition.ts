import type { PatientSourceKind } from '@prisma/client';

/**
 * DX-172: «¿Cómo nos conoció?» de un paciente. La fuente es opcional; el
 * referente (otro paciente de la clínica) solo va con una fuente de tipo
 * PATIENT y el nombre del profesional externo solo con una de tipo
 * EXTERNAL_PROFESSIONAL. Es dato personal: solo lo ve el personal de la
 * clínica (nunca el portal ni lo que se envía al paciente).
 */
export interface PatientAcquisition {
  sourceId: string | null;
  referredByPatientId: string | null;
  referredByName: string | null;
}

/**
 * Lo que llega en un alta o una edición: ausente = no tocar (en la edición) y
 * `null` = vaciar.
 */
export interface PatientAcquisitionInput {
  sourceId?: string | null;
  referredByPatientId?: string | null;
  referredByName?: string | null;
}

/** La fuente leída de la clínica (con la RLS) para decidir. */
export interface AcquisitionSource {
  id: string;
  kind: PatientSourceKind;
  isActive: boolean;
}

export const REFERRED_BY_NAME_MAX = 120;

export const ACQUISITION_MESSAGES = {
  sourceNotFound: 'La fuente elegida no existe en esta clínica.',
  sourceInactive:
    'Esa fuente está desactivada: elige otra o actívala en Ajustes → Origen de pacientes.',
  referrerNeedsPatientSource:
    'El paciente que lo recomendó solo se indica con una fuente de tipo «Recomendación de paciente».',
  nameNeedsProfessionalSource:
    'El nombre del profesional solo se indica con una fuente de tipo «Profesional externo».',
  referralNeedsSource: 'Elige primero cómo nos conoció.',
  referrerNotFound: 'El paciente que lo recomendó no existe en esta clínica.',
  referrerIsSelf: 'Un paciente no puede recomendarse a sí mismo.',
  nameTooLong: `El nombre del profesional admite como mucho ${REFERRED_BY_NAME_MAX} caracteres.`,
} as const;

export const NO_ACQUISITION: PatientAcquisition = {
  sourceId: null,
  referredByPatientId: null,
  referredByName: null,
};

/** ¿Trae la petición algún campo de captación? */
export function touchesAcquisition(input: PatientAcquisitionInput): boolean {
  return (
    input.sourceId !== undefined ||
    input.referredByPatientId !== undefined ||
    input.referredByName !== undefined
  );
}

/** El nombre recortado y con los espacios internos colapsados; vacío = null. */
export function cleanReferredByName(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean === '' ? null : clean;
}

export type AcquisitionProblem = keyof typeof ACQUISITION_MESSAGES;

export type AcquisitionDecision =
  | { ok: true; value: PatientAcquisition }
  | { ok: false; problem: AcquisitionProblem };

/**
 * La captación que queda tras aplicar `input` sobre `stored` (en un alta,
 * `NO_ACQUISITION`). Reglas:
 *  - Al ASIGNAR una fuente distinta de la guardada, tiene que estar activa;
 *    conservar una ya desactivada es válido (no se le quita a nadie).
 *  - Los campos de referencia que no llegan se conservan si encajan con el
 *    tipo de la fuente que queda y se vacían si no (cambiar de «Recomendación
 *    de paciente» a «Instagram» no exige mandar `referredByPatientId: null`).
 *    Un valor explícito que no encaja es un error.
 *  - Sin fuente no hay referente ni nombre.
 * `source` es la fuente que queda (null si queda sin fuente); el caso de uso
 * la lee ANTES de decidir. La existencia del referente y que no sea el propio
 * paciente se comprueban aparte (necesitan la BD).
 */
export function decideAcquisition(
  stored: PatientAcquisition,
  input: PatientAcquisitionInput,
  source: AcquisitionSource | null,
): AcquisitionDecision {
  const sourceId =
    input.sourceId === undefined ? stored.sourceId : input.sourceId;
  const name = cleanReferredByName(input.referredByName);
  if (typeof name === 'string' && [...name].length > REFERRED_BY_NAME_MAX) {
    return { ok: false, problem: 'nameTooLong' };
  }
  if (sourceId === null) {
    if (
      (input.referredByPatientId ?? null) !== null ||
      (name ?? null) !== null
    ) {
      return { ok: false, problem: 'referralNeedsSource' };
    }
    return { ok: true, value: NO_ACQUISITION };
  }
  if (!source || source.id !== sourceId) {
    return { ok: false, problem: 'sourceNotFound' };
  }
  if (!source.isActive && sourceId !== stored.sourceId) {
    return { ok: false, problem: 'sourceInactive' };
  }

  const explicitReferrer = input.referredByPatientId ?? null;
  const explicitName = name ?? null;
  if (source.kind !== 'PATIENT' && explicitReferrer !== null) {
    return { ok: false, problem: 'referrerNeedsPatientSource' };
  }
  if (source.kind !== 'EXTERNAL_PROFESSIONAL' && explicitName !== null) {
    return { ok: false, problem: 'nameNeedsProfessionalSource' };
  }

  const referredByPatientId =
    source.kind !== 'PATIENT'
      ? null
      : input.referredByPatientId === undefined
        ? stored.referredByPatientId
        : input.referredByPatientId;
  const referredByName =
    source.kind !== 'EXTERNAL_PROFESSIONAL'
      ? null
      : name === undefined
        ? stored.referredByName
        : name;
  return { ok: true, value: { sourceId, referredByPatientId, referredByName } };
}

/** ¿Cambió algo? (para no escribir ni auditar una edición vacía). */
export function sameAcquisition(
  a: PatientAcquisition,
  b: PatientAcquisition,
): boolean {
  return (
    a.sourceId === b.sourceId &&
    a.referredByPatientId === b.referredByPatientId &&
    a.referredByName === b.referredByName
  );
}
