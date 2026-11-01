import { createHash } from 'node:crypto';
import { ScheduleBlockKind, TriageFlag } from '@prisma/client';
import {
  OVERRIDE_REASON_MAX,
  OVERRIDE_REASON_MIN,
} from '../../schedule-blocks/domain/reserved-slot';
import { FRONT_DESK_ROLES } from './patient-flow';

/**
 * «Atender sin cita» (DX-470, porción 2 de DX-446): el paciente con dolor que
 * llega sin cita queda, en un solo paso, con una cita de tipo urgente DESDE
 * AHORA en el primer hueco reservado libre del profesional (o en sobrecupo
 * anotado con motivo), ya en «En clínica» (ARRIVED, `arrivedAt` = reloj del
 * servidor) y con su triaje de recepción.
 */

/** Las 6 señales de triaje de recepción, en el orden en que se muestran. */
export const TRIAGE_FLAGS: readonly TriageFlag[] = [
  TriageFlag.PAIN,
  TriageFlag.SWELLING,
  TriageFlag.INFECTION,
  TriageFlag.FEVER,
  TriageFlag.BLEEDING,
  TriageFlag.TRAUMA,
];

export const TRIAGE_NOTE_MAX = 200;

/**
 * Marcar la llegada es trabajo del mostrador (DX-200): recepción, asistencia
 * y administración. El alta mínima que lo acompaña es de PATIENT_ROLES, que
 * los incluye a los tres.
 */
export const WALK_IN_ROLES = FRONT_DESK_ROLES;

/** Código del 409 «sin hueco reservado libre»: la web ofrece el sobrecupo. */
export const NO_RESERVED_SLOT_CODE = 'NO_RESERVED_SLOT';
/** Código del 409 de un documento que ya tiene otro paciente vivo. */
export const PATIENT_DUPLICATE_CODE = 'PATIENT_DUPLICATE';
/**
 * DX-509: código del 409 al deshacer la llegada o reactivar un sobrecupo cuyo
 * hueco ya ocupa otra cita del profesional. Con `canKeepOverbooked`: se puede
 * reintentar con `keepOverbooked: true` (sigue en sobrecupo, auditado).
 */
export const OVERBOOK_SLOT_TAKEN_CODE = 'OVERBOOK_SLOT_TAKEN';
/** DX-510: código del 422 de una Idempotency-Key repetida con otros datos. */
export const IDEMPOTENCY_KEY_REUSED_CODE = 'IDEMPOTENCY_KEY_REUSED';

/**
 * DX-509: códigos de auditoría del fin de un sobrecupo. `CLEARED`: deja de
 * serlo (se movió, o al deshacer la llegada o reactivarla su hueco estaba
 * libre) y pasa a contar en el anti-solape del profesional. `KEPT`: quien
 * deshace la llegada o reactiva la mantiene en sobrecupo a sabiendas.
 */
export const OVERBOOK_AUDIT_REASONS = {
  cleared: 'WALK_IN_OVERBOOK_CLEARED',
  kept: 'WALK_IN_OVERBOOK_KEPT',
} as const;

export const WALK_IN_MESSAGES = {
  forbidden:
    '«Atender sin cita» lo usan recepción, la asistente o la administración.',
  patientChoice:
    'Elige un paciente existente o da de alta uno nuevo (no los dos).',
  newPatientBlank:
    'El paciente nuevo necesita nombre, apellido y un teléfono de contacto (al menos 5 caracteres).',
  noUrgentType:
    'No hay ningún tipo de cita de urgencia activo. Marca uno como «Urgencia» en Tipos de cita.',
  notUrgentType:
    'El tipo de cita elegido no es de urgencia o está desactivado.',
  noReservedSlot:
    'No queda ningún hueco reservado libre hoy para este profesional. Puedes atenderlo en sobrecupo indicando el motivo.',
  slotTaken:
    'Otra persona acaba de ocupar ese hueco. Vuelve a intentarlo para buscar el siguiente.',
  overbookSlotTaken:
    'Esta urgencia se atendió en sobrecupo y su hora ya la ocupa otra cita del profesional. Muévela a otra hora o mantenla como sobrecupo.',
  idempotencyKeyInvalid: 'La clave de idempotencia debe ser un UUID.',
  idempotencyKeyReused:
    'Esta atención sin cita ya se registró con otros datos. Revisa «En clínica» antes de volver a intentarlo.',
} as const;

/** Las señales sin repetir y en el orden canónico. */
export function normalizeTriageFlags(
  flags: readonly TriageFlag[] | undefined,
): TriageFlag[] {
  const set = new Set(flags ?? []);
  return TRIAGE_FLAGS.filter((f) => set.has(f));
}

/** La nota recortada (`null` si queda vacía). */
export function normalizeTriageNote(
  note: string | null | undefined,
): string | null {
  const trimmed = note?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

export function triageNoteError(
  note: string | null | undefined,
): string | null {
  const normalized = normalizeTriageNote(note);
  return normalized !== null && normalized.length > TRIAGE_NOTE_MAX
    ? `La nota de triaje admite como mucho ${TRIAGE_NOTE_MAX} caracteres.`
    : null;
}

/** Motivo del sobrecupo: las mismas reglas que el «Agendar igualmente» (DX-446). */
export function overbookReasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (
    trimmed.length < OVERRIDE_REASON_MIN ||
    trimmed.length > OVERRIDE_REASON_MAX
  ) {
    return `El motivo del sobrecupo debe tener entre ${OVERRIDE_REASON_MIN} y ${OVERRIDE_REASON_MAX} caracteres.`;
  }
  return /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(trimmed)
    ? 'El motivo del sobrecupo va en una sola línea.'
    : null;
}

/** La cita empieza en el minuto en curso (sin segundos). */
export function floorToMinute(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000);
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface ReservedBlockCandidate extends Interval {
  id: string;
  kind: ScheduleBlockKind;
  reservedForTypeIds: string[];
}

export interface ReservedSlotSearch {
  /** Desde cuándo (ya redondeado al minuto). */
  now: Date;
  /** Hasta cuándo puede empezar: el final del día civil en la sede. */
  until: Date;
  durationMinutes: number;
  /** El tipo urgente de la cita: solo cuentan los reservados que lo admiten. */
  appointmentTypeId: string;
  /** Bloques del profesional en la sede (los no reservados se ignoran). */
  blocks: readonly ReservedBlockCandidate[];
  /** Citas que ocupan al profesional o al paciente (vivas, sin sobrecupo). */
  busy: readonly Interval[];
}

export interface ReservedSlot extends Interval {
  blockId: string;
}

const overlaps = (a: Interval, b: Interval): boolean =>
  a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();

/**
 * Primer hueco libre en un bloque RESERVED que admite el tipo urgente: el
 * inicio cae dentro del bloque, desde ahora y hoy, y la cita entera no pisa
 * ninguna ocupada. Entre bloques, el que antes empieza. `null` si no hay.
 */
export function findReservedSlot(
  search: ReservedSlotSearch,
): ReservedSlot | null {
  const durationMs = search.durationMinutes * 60_000;
  const busy = [...search.busy].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
  let best: ReservedSlot | null = null;
  for (const block of search.blocks) {
    if (
      block.kind !== ScheduleBlockKind.RESERVED ||
      !block.reservedForTypeIds.includes(search.appointmentTypeId)
    ) {
      continue;
    }
    const limit = Math.min(block.end.getTime(), search.until.getTime());
    let start = Math.max(block.start.getTime(), search.now.getTime());
    while (start < limit) {
      const candidate = {
        start: new Date(start),
        end: new Date(start + durationMs),
      };
      const clash = busy.find((b) => overlaps(b, candidate));
      if (!clash) {
        if (best === null || candidate.start < best.start) {
          best = { ...candidate, blockId: block.id };
        }
        break;
      }
      start = Math.max(start + 1, clash.end.getTime());
    }
  }
  return best;
}

/** DX-510: lo que identifica una petición de «Atender sin cita». */
export interface WalkInRequestShape {
  /** Sede ya resuelta (cabecera o sede de escritura de la sesión). */
  locationId: string;
  patientId?: string;
  newPatient?: {
    firstName: string;
    lastName: string;
    phone: string;
    docType?: string;
    docTypeLabel?: string | null;
    docNumber?: string;
  };
  providerId: string;
  appointmentTypeId?: string;
  triageFlags?: readonly TriageFlag[];
  triageNote?: string | null;
  overbookReason?: string;
}

const lowerId = (id: string | undefined): string | null =>
  id === undefined ? null : id.toLowerCase();
const trimmedOrNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

/**
 * DX-510: huella (SHA-256 hex) de la petición, con la normalización que
 * aplica el caso de uso (recortes, señales sin repetir y en su orden, ids en
 * minúsculas) y la sede: el mismo cuerpo escrito de dos formas es la misma
 * petición; otro paciente, profesional, tipo, triaje, motivo o sede, no.
 */
export function walkInRequestFingerprint(input: WalkInRequestShape): string {
  const p = input.newPatient;
  const parts = [
    'WALK_IN',
    input.locationId.toLowerCase(),
    lowerId(input.patientId),
    p
      ? [
          p.firstName.trim(),
          p.lastName.trim(),
          p.phone.trim(),
          p.docType ?? null,
          trimmedOrNull(p.docTypeLabel),
          trimmedOrNull(p.docNumber),
        ]
      : null,
    input.providerId.toLowerCase(),
    lowerId(input.appointmentTypeId),
    normalizeTriageFlags(input.triageFlags),
    normalizeTriageNote(input.triageNote),
    trimmedOrNull(input.overbookReason),
  ];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
