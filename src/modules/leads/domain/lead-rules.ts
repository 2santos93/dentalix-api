/**
 * DX-556 · Prospectos: las reglas puras (etapas, catálogo predefinido,
 * topes, «sin contactar» y el reparto del nombre al convertir). Sin Nest ni
 * Prisma: las prueba `lead-rules.spec.ts`.
 */

export const LEAD_STAGES = [
  'NEW',
  'CONTACTED',
  'SCHEDULED',
  'ATTENDED',
  'LOST',
] as const;
export type LeadStageCode = (typeof LEAD_STAGES)[number];

export const LEAD_CHANNELS = [
  'WHATSAPP',
  'INSTAGRAM',
  'FACEBOOK',
  'PHONE',
  'WALK_IN',
  'REFERRAL',
  'WEBSITE',
  'OTHER',
] as const;
export type LeadChannelCode = (typeof LEAD_CHANNELS)[number];

export const LEAD_REASON_KINDS = ['INTEREST', 'LOSS'] as const;
export type LeadReasonKindCode = (typeof LEAD_REASON_KINDS)[number];

/** Topes (los mismos CHECK en la BD). */
export const LEAD_NAME_MAX = 120;
export const LEAD_PHONE_INPUT_MAX = 40;
export const LEAD_REASON_MIN = 2;
export const LEAD_REASON_MAX = 60;
export const LEAD_NEXT_ACTION_NOTE_MAX = 200;
export const LEAD_NOTE_MAX = 1000;
export const LEAD_RETENTION_MONTHS_MIN = 1;
export const LEAD_RETENTION_MONTHS_MAX = 120;
/** Horas sin contacto tras las que un prospecto abierto cuenta en «Mi día». */
export const LEAD_STALE_HOURS = 24;

/** Nombre que queda en un prospecto anonimizado por la retención. */
export const LEAD_ANONYMIZED_NAME = 'Anonimizado';

/**
 * Motivos predefinidos (constantes, como las categorías de gasto de DX-274):
 * neutros y sin datos de salud. La clínica añade los suyos en Ajustes.
 */
export const PREDEFINED_LEAD_REASONS: Record<
  LeadReasonKindCode,
  readonly string[]
> = {
  INTEREST: [
    'Valoración general',
    'Limpieza',
    'Ortodoncia',
    'Implantes',
    'Blanqueamiento',
    'Estética dental',
    'Precio de un tratamiento',
  ],
  LOSS: [
    'Precio',
    'No respondió',
    'Eligió otra clínica',
    'Horario o distancia',
    'Ya no lo necesita',
    'Datos de contacto erróneos',
  ],
};

export const LEAD_MESSAGES = {
  notFound: 'Prospecto no encontrado',
  phoneInvalid:
    'El teléfono no es válido. Escríbelo con el prefijo del país (p. ej. +58 412 1234567).',
  phoneTaken: 'Ese teléfono ya es de un paciente o de otro prospecto.',
  lostReasonRequired:
    'Para marcarlo como perdido elige un motivo del catálogo.',
  reasonNotInCatalog: 'El motivo no está en el catálogo de la clínica.',
  stageByAppointment:
    '«Cita agendada» y «Asistió» los pone la cita: agenda la primera cita desde el prospecto.',
  stageNotAllowed: 'Ese cambio de etapa no está permitido.',
  sameStage: 'El prospecto ya está en esa etapa.',
  anonymized: 'El prospecto está anonimizado: ya no se puede modificar.',
  ownerInvalid:
    'El responsable tiene que ser un administrador o recepcionista activo de la clínica.',
  lastNameRequired: 'Escribe el apellido para crear la ficha del paciente.',
  ambiguousPatients:
    'Hay varios pacientes con ese teléfono: elige con cuál enlazar el prospecto.',
  patientNotCandidate:
    'Ese paciente no tiene el teléfono del prospecto: elige uno de la lista.',
  reasonTaken: 'Ya existe un motivo con ese nombre.',
  reasonNotFound: 'Motivo no encontrado',
  reasonPredefined: 'Los motivos predefinidos no se pueden retirar.',
  nextActionNoteWithoutDate: 'La nota de la próxima acción necesita una fecha.',
  rangeInvalid: 'El período no es válido: «desde» va antes de «hasta».',
} as const;

export const LEAD_PHONE_TAKEN_CODE = 'LEAD_PHONE_TAKEN';
export const LEAD_AMBIGUOUS_PATIENTS_CODE = 'LEAD_AMBIGUOUS_PATIENTS';

/** Etapas a las que se mueve A MANO desde cada una (sin contar LOST→…). */
const MANUAL_MOVES: Record<LeadStageCode, readonly LeadStageCode[]> = {
  NEW: ['CONTACTED', 'LOST'],
  CONTACTED: ['NEW', 'LOST'],
  // La cita se cayó: vuelve a seguimiento, o se pierde.
  SCHEDULED: ['CONTACTED', 'LOST'],
  // Asistió: final (ganado).
  ATTENDED: [],
  // Reabrir.
  LOST: ['NEW', 'CONTACTED'],
};

export type StageMoveDecision =
  | { ok: true }
  | {
      ok: false;
      reason: 'SAME' | 'BY_APPOINTMENT' | 'NOT_ALLOWED' | 'LOST_REASON';
    };

/**
 * Decide un cambio de etapa MANUAL. «Cita agendada» y «Asistió» solo los pone
 * la cita (DX-556); «Perdido» exige motivo.
 */
export function decideManualMove(
  from: LeadStageCode,
  to: LeadStageCode,
  lostReason: string | null,
): StageMoveDecision {
  if (from === to) return { ok: false, reason: 'SAME' };
  if (to === 'SCHEDULED' || to === 'ATTENDED') {
    return { ok: false, reason: 'BY_APPOINTMENT' };
  }
  if (!MANUAL_MOVES[from].includes(to)) {
    return { ok: false, reason: 'NOT_ALLOWED' };
  }
  if (to === 'LOST' && !lostReason?.trim()) {
    return { ok: false, reason: 'LOST_REASON' };
  }
  return { ok: true };
}

/** Etapas desde las que una cita nueva del paciente lo pasa a SCHEDULED. */
export const SCHEDULABLE_STAGES: readonly LeadStageCode[] = [
  'NEW',
  'CONTACTED',
];
/** Etapa desde la que la cita atendida lo pasa a ATTENDED. */
export const ATTENDABLE_STAGES: readonly LeadStageCode[] = ['SCHEDULED'];
/** Etapas abiertas (las que cuentan para «sin contactar»). */
export const OPEN_STAGES: readonly LeadStageCode[] = ['NEW', 'CONTACTED'];

/**
 * «Sin contactar hace más de 24 h» (Mi día): abierto, sin contacto en 24 h
 * (o sin ninguno desde el alta) y sin una próxima acción pendiente (no tiene
 * o ya venció). El criterio literal es «sin próxima acción»; una vencida
 * también es seguimiento que se escapa. La consulta SQL lo repite con la hora
 * de la BD.
 */
export function isStale(
  lead: {
    stage: LeadStageCode;
    anonymizedAt: Date | null;
    createdAt: Date;
    lastContactAt: Date | null;
    nextActionAt: Date | null;
  },
  now: Date,
): boolean {
  if (!OPEN_STAGES.includes(lead.stage) || lead.anonymizedAt) return false;
  const since = (lead.lastContactAt ?? lead.createdAt).getTime();
  if (now.getTime() - since < LEAD_STALE_HOURS * 3_600_000) return false;
  return lead.nextActionAt === null || lead.nextActionAt <= now;
}

/** Texto recortado con espacios internos colapsados; `null` si queda vacío. */
export function cleanText(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text ? text : null;
}

/**
 * Nombre y apellido para la ficha a partir del nombre del prospecto: la
 * primera palabra es el nombre y el resto el apellido. Con una sola palabra,
 * el apellido queda vacío (la API lo pide).
 */
export function splitFullName(fullName: string): {
  firstName: string;
  lastName: string;
} {
  const words = cleanText(fullName)?.split(' ') ?? [];
  return { firstName: words[0] ?? '', lastName: words.slice(1).join(' ') };
}

/** El motivo tal cual está en el catálogo (sin distinguir mayúsculas), o null. */
export function matchCatalogReason(
  value: string,
  catalog: readonly string[],
): string | null {
  const wanted = cleanText(value)?.toLocaleLowerCase('es');
  if (!wanted) return null;
  return catalog.find((r) => r.toLocaleLowerCase('es') === wanted) ?? null;
}

/** Tasa de un paso (0..1 con 4 decimales); 0 si no hay base. */
export function stepRate(part: number, base: number): number {
  if (base <= 0) return 0;
  return Math.round((part / base) * 10_000) / 10_000;
}
