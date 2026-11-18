import type { ScheduleRange } from '../../location-schedule/application/business-hours';
import type { MinuteRange } from '../../provider-schedule/domain/provider-availability';
import {
  findOpenings,
  type Interval,
} from '../../appointments/domain/openings';
import {
  addCivilDays,
  civilDateIn,
  zonedStartOfDay,
} from '../../../shared/time/civil-day';

/**
 * DX-016: huecos que ofrece la reserva online. Puro: sin reloj ni BD (los
 * tests fijan `now`).
 *
 * Parte del MISMO cálculo que «Buscar hueco» (`findOpenings`, DX-122): tramos
 * del horario de la sede ∩ los del profesional en la sede (DX-233), sin
 * festivos de la sede (DX-316) y sin lo ocupado (citas y bloqueos). Encima,
 * las reglas de la página pública:
 * - sede SIN horario configurado → ningún hueco (la agenda interna la deja
 *   libre; la página pública nunca ofrece una hora que nadie fijó);
 * - antelación mínima (`minLeadMinutes`) y máxima (`maxAdvanceDays`);
 * - cada hueco empieza en un múltiplo del paso en hora de PARED de la sede
 *   (9:00, 9:15…), y cabe entero (`durationMinutes`).
 * Varios profesionales: un inicio sale una vez, con el primero libre en el
 * orden recibido (determinista: la reserva elige ese mismo).
 */

export const MAX_ONLINE_SLOT_DAYS = 14;
export const MAX_ONLINE_SLOTS = 500;

/** Lo que la página ve de un hueco: cuándo y con quién. Nada más. */
export interface OnlineSlot {
  start: Date;
  end: Date;
  providerId: string;
}

export interface ProviderAgenda {
  providerId: string;
  /** Citas del profesional y bloqueos que le afectan en la sede. */
  busy: readonly Interval[];
  /** DX-233: sus tramos en la sede por día (`null` = sin restricción). */
  rangesOn?: (day: string) => readonly MinuteRange[] | null;
}

export interface OnlineSlotsQuery {
  fromDay: string;
  toDay: string;
  timeZone: string;
  /** Horario semanal de la sede; vacío o `null` = sin horario → sin huecos. */
  ranges: readonly ScheduleRange[] | null;
  isClosedDay: (day: string) => boolean;
  providers: readonly ProviderAgenda[];
  /** Citas del propio paciente (existente): tampoco puede estar en dos. */
  patientBusy?: readonly Interval[];
  durationMinutes: number;
  stepMinutes: number;
  now: Date;
  minLeadMinutes: number;
  maxAdvanceDays: number;
  limit?: number;
}

export interface OnlineSlotsResult {
  slots: OnlineSlot[];
  truncated: boolean;
}

const MINUTE = 60_000;

/** Minutos de pared desde el inicio del día civil del instante en la zona. */
function wallMinuteOfDay(instant: Date, timeZone: string): number {
  const day = civilDateIn(instant, timeZone);
  return Math.round(
    (instant.getTime() - zonedStartOfDay(day, timeZone).getTime()) / MINUTE,
  );
}

/** El último instante en que puede EMPEZAR un hueco (antelación máxima). */
export function latestOnlineStart(now: Date, maxAdvanceDays: number): Date {
  return new Date(now.getTime() + maxAdvanceDays * 24 * 60 * MINUTE);
}

/** El primer instante en que puede empezar (antelación mínima). */
export function earliestOnlineStart(now: Date, minLeadMinutes: number): Date {
  return new Date(now.getTime() + minLeadMinutes * MINUTE);
}

/** Inicios alineados al paso (en hora de pared) dentro de un hueco libre. */
function startsWithin(
  opening: Interval,
  durationMs: number,
  stepMinutes: number,
  timeZone: string,
  latest: number,
): Date[] {
  const minute = wallMinuteOfDay(opening.start, timeZone);
  const shift =
    (Math.ceil(minute / stepMinutes) * stepMinutes - minute) * MINUTE;
  const out: Date[] = [];
  const end = opening.end.getTime();
  for (
    let t = opening.start.getTime() + shift;
    t + durationMs <= end && t <= latest;
    t += stepMinutes * MINUTE
  ) {
    out.push(new Date(t));
  }
  return out;
}

export function computeOnlineSlots(query: OnlineSlotsQuery): OnlineSlotsResult {
  const limit = query.limit ?? MAX_ONLINE_SLOTS;
  if (!query.ranges || query.ranges.length === 0) {
    return { slots: [], truncated: false };
  }
  const earliest = earliestOnlineStart(query.now, query.minLeadMinutes);
  const latest = latestOnlineStart(query.now, query.maxAdvanceDays).getTime();
  const durationMs = query.durationMinutes * MINUTE;
  const byStart = new Map<number, OnlineSlot>();

  for (const provider of query.providers) {
    const { openings } = findOpenings({
      fromDay: query.fromDay,
      toDay: query.toDay,
      timeZone: query.timeZone,
      ranges: query.ranges,
      busy: [...provider.busy, ...(query.patientBusy ?? [])],
      durationMinutes: query.durationMinutes,
      now: earliest,
      limit: 10_000,
      providerRangesOn: provider.rangesOn,
      isClosedDay: query.isClosedDay,
    });
    for (const opening of openings) {
      for (const start of startsWithin(
        opening,
        durationMs,
        query.stepMinutes,
        query.timeZone,
        latest,
      )) {
        const key = start.getTime();
        if (!byStart.has(key)) {
          byStart.set(key, {
            start,
            end: new Date(key + durationMs),
            providerId: provider.providerId,
          });
        }
      }
    }
  }

  const slots = [...byStart.values()].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
  return {
    slots: slots.slice(0, limit),
    truncated: slots.length > limit,
  };
}

/** Días civiles de la consulta, recortados a la ventana de la antelación. */
export function clampOnlineDays(
  fromDay: string,
  days: number,
  timeZone: string,
  now: Date,
  maxAdvanceDays: number,
): { fromDay: string; toDay: string } | null {
  const today = civilDateIn(now, timeZone);
  const lastDay = civilDateIn(latestOnlineStart(now, maxAdvanceDays), timeZone);
  const from = fromDay < today ? today : fromDay;
  const wanted = addCivilDays(from, Math.min(days, MAX_ONLINE_SLOT_DAYS) - 1);
  const to = wanted > lastDay ? lastDay : wanted;
  return from > to ? null : { fromDay: from, toDay: to };
}
