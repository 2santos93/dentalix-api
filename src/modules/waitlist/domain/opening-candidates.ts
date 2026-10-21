import type {
  AppointmentStatus,
  WaitlistPriority,
  WaitlistStatus,
} from '@prisma/client';
import { civilDateIn } from '../../../shared/time/civil-day';

/**
 * «Ocupar este hueco» (DX-210): quién de la clínica podría ocupar un hueco
 * libre de la agenda. Puro: sin reloj ni BD (el repositorio trae ya filtrado
 * lo grueso y esto aplica TODA la regla, para que los tests la fijen).
 */

/** Tope de candidatos por respuesta. */
export const OPENING_CANDIDATES_LIMIT = 50;
/** Un hueco de como mucho 8 h (la duración máxima de una cita). */
export const OPENING_MAX_MINUTES = 480;

/** Estados de una cita que se puede adelantar. */
export const MOVABLE_STATUSES: readonly AppointmentStatus[] = [
  'SCHEDULED',
  'CONFIRMED',
];

export interface CandidateSlot {
  locationId: string;
  /** Profesional del hueco (la columna); `null` = cualquiera de la sede. */
  providerId: string | null;
  start: Date;
  end: Date;
  /** Zona de la sede: «el mismo día» se mide en ella. */
  timeZone: string;
}

/** Lo que la regla mira de un pendiente de la lista (DX-122). */
export interface EntryCandidateSource {
  id: string;
  locationId: string;
  providerId: string | null;
  durationMinutes: number;
  priority: WaitlistPriority;
  status: WaitlistStatus;
  createdAt: Date;
  /** La cita cancelada que originó la entrada (null en un alta manual). */
  sourceAppointment: { start: Date; end: Date } | null;
}

/** Lo que la regla mira de una cita agendada. */
export interface AppointmentCandidateSource {
  id: string;
  locationId: string;
  providerId: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  wantsEarlier: boolean;
  createdAt: Date;
}

export type RankedCandidate<
  E extends EntryCandidateSource,
  A extends AppointmentCandidateSource,
> = { kind: 'WAITLIST'; source: E } | { kind: 'APPOINTMENT'; source: A };

export interface RankedCandidates<
  E extends EntryCandidateSource,
  A extends AppointmentCandidateSource,
> {
  items: RankedCandidate<E, A>[];
  /** Había más de `OPENING_CANDIDATES_LIMIT`. */
  truncated: boolean;
}

const MINUTE = 60_000;

function overlaps(a: { start: Date; end: Date }, b: CandidateSlot): boolean {
  return a.start < b.end && a.end > b.start;
}

/** El pendiente cabe en el hueco: misma sede, abierto, duración y profesional. */
export function entryFits(
  slot: CandidateSlot,
  e: EntryCandidateSource,
): boolean {
  const slotMinutes = (slot.end.getTime() - slot.start.getTime()) / MINUTE;
  return (
    e.status === 'OPEN' &&
    e.locationId === slot.locationId &&
    e.durationMinutes <= slotMinutes &&
    (slot.providerId === null ||
      e.providerId === null ||
      e.providerId === slot.providerId) &&
    // Quien acaba de liberar ESTE hueco no es candidato para él.
    !(e.sourceAppointment && overlaps(e.sourceAppointment, slot))
  );
}

/**
 * La cita se puede adelantar al hueco: marcada, viva, misma sede y
 * profesional, cabe, y es de un día civil (zona de la sede) POSTERIOR al del
 * hueco. Las del mismo día no: adelantar unas horas no ayuda al paciente y
 * deja otro hueco el mismo día.
 */
export function appointmentFits(
  slot: CandidateSlot,
  a: AppointmentCandidateSource,
): boolean {
  const slotMs = slot.end.getTime() - slot.start.getTime();
  return (
    a.wantsEarlier &&
    MOVABLE_STATUSES.includes(a.status) &&
    a.locationId === slot.locationId &&
    (slot.providerId === null || a.providerId === slot.providerId) &&
    a.end.getTime() - a.start.getTime() <= slotMs &&
    civilDateIn(a.start, slot.timeZone) > civilDateIn(slot.start, slot.timeZone)
  );
}

function byAge(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): number {
  return (
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * DX-233: «¿este profesional atiende `[start, end)` en la sede del hueco?»
 * (horario del profesional por sede; sin horario, siempre sí).
 */
export type CanAttend = (providerId: string, start: Date, end: Date) => boolean;

/** El candidato ocuparía `[slot.start, slot.start + su duración)`. */
function attends(
  canAttend: CanAttend | undefined,
  providerId: string | null,
  slot: CandidateSlot,
  minutes: number,
): boolean {
  if (!canAttend || providerId === null) return true;
  return canAttend(
    providerId,
    slot.start,
    new Date(slot.start.getTime() + minutes * MINUTE),
  );
}

/**
 * Filtra y ordena: primero los pendientes URGENT, luego el resto de
 * pendientes, luego las citas a adelantar (la más lejana primero, que es a
 * quien más le sirve); a igualdad, la más antigua. Tope de 50. Con
 * `canAttend` (DX-233) se quedan fuera los que caerían fuera del horario de
 * su profesional (el del hueco o el suyo) en esa sede.
 */
export function rankOpeningCandidates<
  E extends EntryCandidateSource,
  A extends AppointmentCandidateSource,
>(
  slot: CandidateSlot,
  sources: { entries: readonly E[]; appointments: readonly A[] },
  limit = OPENING_CANDIDATES_LIMIT,
  canAttend?: CanAttend,
): RankedCandidates<E, A> {
  const entries = sources.entries
    .filter(
      (e) =>
        entryFits(slot, e) &&
        attends(
          canAttend,
          slot.providerId ?? e.providerId,
          slot,
          e.durationMinutes,
        ),
    )
    .sort(
      (a, b) =>
        Number(b.priority === 'URGENT') - Number(a.priority === 'URGENT') ||
        byAge(a, b),
    );
  const appointments = sources.appointments
    .filter(
      (a) =>
        appointmentFits(slot, a) &&
        attends(
          canAttend,
          a.providerId,
          slot,
          (a.end.getTime() - a.start.getTime()) / MINUTE,
        ),
    )
    .sort((a, b) => b.start.getTime() - a.start.getTime() || byAge(a, b));
  const all: RankedCandidate<E, A>[] = [
    ...entries.map((source) => ({ kind: 'WAITLIST' as const, source })),
    ...appointments.map((source) => ({ kind: 'APPOINTMENT' as const, source })),
  ];
  return { items: all.slice(0, limit), truncated: all.length > limit };
}
