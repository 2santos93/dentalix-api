import { round2 } from '../../../shared/money/money';
import {
  addCivilDays,
  civilDateIn,
  civilWeekday,
} from '../../../shared/time/civil-day';

/*
 * «Huecos recuperados» (DX-436): reglas puras del emparejamiento hueco ↔
 * relleno y de las métricas. El repositorio trae las filas; aquí se decide qué
 * cuenta.
 *
 * Hueco liberado: cita CANCELADA o en INASISTENCIA (NO_SHOW) cuya liberación
 * (`cancelledAt` / `noShowMarkedAt`, DX-279) fue al menos 1 h antes de su
 * inicio: con menos aviso el hueco no se puede ofrecer y solo hundiría la
 * tasa de relleno (la cancelación sigue contando en la tasa de cancelación).
 *
 * Relleno: cita viva NO cancelada del MISMO profesional y la MISMA sede que se
 * solapa con el hueco y LLEGÓ a él después de liberarse y antes de que
 * terminara. «Llegó» = se creó ahí o se movió ahí (el último movimiento que la
 * metió en el hueco, del rastro de auditoría): así cuenta la cita adelantada
 * desde «Adelantar si hay hueco», y no la de un sobrecupo creado antes de la
 * cancelación.
 */

/** Aviso mínimo de una liberación para que el hueco cuente (minutos). */
export const FREED_MIN_NOTICE_MINUTES = 60;

const MINUTE_MS = 60_000;

export interface FreedSlot {
  id: string;
  locationId: string;
  providerId: string;
  start: Date;
  end: Date;
  /** Cuándo se canceló o se marcó la inasistencia. */
  freedAt: Date;
  /** Zona de la sede: la semana del hueco es la de su día civil allí. */
  timeZone: string;
}

export interface MoneyAmount {
  currency: string;
  amount: number;
}

/** Una cita que se solapa con un hueco, con lo que hace falta para decidir. */
export interface FillCandidate {
  /** El hueco con el que se solapa (una fila por par hueco ↔ cita). */
  slotId: string;
  appointmentId: string;
  locationId: string;
  providerId: string;
  start: Date;
  end: Date;
  /** Cuándo llegó la cita a su hora actual (creación o último movimiento). */
  arrivedAt: Date;
  /** Nació de un pendiente o de una oferta ACEPTADA de este hueco. */
  byList: boolean;
}

export type SlotFill = 'FILLED' | 'PARTIAL' | 'OPEN';

export interface SlotOutcome {
  slot: FreedSlot;
  fill: SlotFill;
  freedMinutes: number;
  recoveredMinutes: number;
  /** Desde la liberación hasta la primera cita que lo ocupó (null si nada). */
  minutesToFill: number | null;
  byList: boolean;
  /** Citas que aportaron minutos a este hueco, en orden de llegada. */
  fillerIds: string[];
}

interface Segment {
  start: number;
  end: number;
}

function subtract(piece: Segment, taken: readonly Segment[]): Segment[] {
  let pieces = [piece];
  for (const t of taken) {
    pieces = pieces.flatMap((p) => {
      if (t.end <= p.start || t.start >= p.end) return [p];
      const out: Segment[] = [];
      if (t.start > p.start) out.push({ start: p.start, end: t.start });
      if (t.end < p.end) out.push({ start: t.end, end: p.end });
      return out;
    });
  }
  return pieces;
}

const length = (segments: readonly Segment[]) =>
  segments.reduce((sum, s) => sum + (s.end - s.start), 0);

/** ¿La cita cuenta como relleno de ESE hueco? */
export function fillsSlot(slot: FreedSlot, c: FillCandidate): boolean {
  return (
    c.appointmentId !== slot.id &&
    c.providerId === slot.providerId &&
    c.locationId === slot.locationId &&
    c.start.getTime() < slot.end.getTime() &&
    c.end.getTime() > slot.start.getTime() &&
    c.arrivedAt.getTime() > slot.freedAt.getTime() &&
    c.arrivedAt.getTime() < slot.end.getTime()
  );
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Emparejamiento determinista, por minutos: cada minuto de una cita cuenta
 * en UN solo hueco y cada minuto de un hueco se recupera una sola vez. Los
 * huecos se reparten del liberado más tarde al más temprano (la cita responde
 * a la liberación más reciente que tenía delante: si una hora se libera dos
 * veces, el relleno final es de la segunda), y dentro de un hueco las citas
 * por orden de llegada. Empates por inicio e id.
 */
export function matchRecoveredSlots(
  slots: readonly FreedSlot[],
  candidates: readonly FillCandidate[],
): SlotOutcome[] {
  const bySlot = new Map<string, FillCandidate[]>();
  for (const c of candidates) {
    const list = bySlot.get(c.slotId) ?? [];
    list.push(c);
    bySlot.set(c.slotId, list);
  }
  const consumed = new Map<string, Segment[]>();
  const ordered = [...slots].sort(
    (a, b) =>
      b.freedAt.getTime() - a.freedAt.getTime() ||
      a.start.getTime() - b.start.getTime() ||
      byText(a.id, b.id),
  );
  const outcomes = new Map<string, SlotOutcome>();
  for (const slot of ordered) {
    const slotSegment = {
      start: slot.start.getTime(),
      end: slot.end.getTime(),
    };
    const covered: Segment[] = [];
    const fillers: FillCandidate[] = [];
    const eligible = (bySlot.get(slot.id) ?? [])
      .filter((c) => fillsSlot(slot, c))
      .sort(
        (a, b) =>
          a.arrivedAt.getTime() - b.arrivedAt.getTime() ||
          a.start.getTime() - b.start.getTime() ||
          byText(a.appointmentId, b.appointmentId),
      );
    for (const c of eligible) {
      const overlap = {
        start: Math.max(slotSegment.start, c.start.getTime()),
        end: Math.min(slotSegment.end, c.end.getTime()),
      };
      const used = consumed.get(c.appointmentId) ?? [];
      const fresh = subtract(overlap, [...used, ...covered]);
      if (length(fresh) === 0) continue;
      covered.push(...fresh);
      used.push(...fresh);
      consumed.set(c.appointmentId, used);
      fillers.push(c);
    }
    const freedMs = slotSegment.end - slotSegment.start;
    const recoveredMs = length(covered);
    const first = fillers[0];
    outcomes.set(slot.id, {
      slot,
      fill:
        recoveredMs === 0
          ? 'OPEN'
          : recoveredMs >= freedMs
            ? 'FILLED'
            : 'PARTIAL',
      freedMinutes: freedMs / MINUTE_MS,
      recoveredMinutes: recoveredMs / MINUTE_MS,
      minutesToFill: first
        ? (first.arrivedAt.getTime() - slot.freedAt.getTime()) / MINUTE_MS
        : null,
      byList: fillers.some((f) => f.byList),
      fillerIds: fillers.map((f) => f.appointmentId),
    });
  }
  // Orden de salida estable: por inicio del hueco.
  return slots
    .map((s) => outcomes.get(s.id)!)
    .sort(
      (a, b) =>
        a.slot.start.getTime() - b.slot.start.getTime() ||
        byText(a.slot.id, b.slot.id),
    );
}

// --- Semanas ISO --------------------------------------------------------

/** Lunes (AAAA-MM-DD) de la semana ISO del día civil `day`. */
export function isoWeekStart(day: string): string {
  return addCivilDays(day, -((civilWeekday(day) + 6) % 7));
}

/** Los lunes de todas las semanas que toca el período, en orden. */
export function weeksOfPeriod(from: string, to: string): string[] {
  const weeks: string[] = [];
  for (let w = isoWeekStart(from); w <= to; w = addCivilDays(w, 7)) {
    weeks.push(w);
  }
  return weeks;
}

/** Semana del hueco: la de su día civil en la zona de su sede. */
export function slotWeek(slot: FreedSlot): string {
  return isoWeekStart(civilDateIn(slot.start, slot.timeZone));
}

// --- Métricas -------------------------------------------------------------

export interface OfferCounts {
  sent: number;
  accepted: number;
  declined: number;
  unanswered: number;
}

export interface RecoveredSlotsMetrics {
  freedSlots: number;
  freedMinutes: number;
  filledSlots: number;
  partiallyFilledSlots: number;
  recoveredMinutes: number;
  filledByListSlots: number;
  /** (rellenados + parciales) / liberados, 0..1. */
  fillRate: number | null;
  /** Rellenados (completos o parciales) en ≤ 30 min / liberados. */
  filledWithin30MinRate: number | null;
  /** Rellenados (completos o parciales) en ≤ 24 h / liberados. */
  filledWithin24hRate: number | null;
  meanMinutesToFill: number | null;
  /** Canceladas / agendadas del período. */
  cancellationRate: number | null;
  offers: OfferCounts;
  /** Por moneda, nunca sumadas entre sí. */
  recoveredValue: MoneyAmount[];
  /** Huecos recuperados cuyas citas no tienen ítems del plan ligados. */
  unvaluedRecoveredSlots: number;
}

/** Citas agendadas y canceladas de un profesional en un día civil. */
export interface AppointmentDayCount {
  providerId: string;
  day: string;
  scheduled: number;
  cancelled: number;
}

export type OfferOutcomeBucket = 'ACCEPTED' | 'DECLINED' | 'UNANSWERED';

/** Ofertas de huecos de un profesional en un día civil, por desenlace. */
export interface OfferDayCount {
  providerId: string;
  day: string;
  outcome: OfferOutcomeBucket;
  count: number;
}

/**
 * Desenlace de una oferta (DX-210/DX-435) para el informe: «sin respuesta»
 * junta las pendientes, las anotadas sin respuesta, las caducadas y las que
 * otro paciente se quedó antes de que contestara.
 */
export function offerBucket(outcome: string): OfferOutcomeBucket {
  if (outcome === 'ACCEPTED') return 'ACCEPTED';
  if (outcome === 'DECLINED') return 'DECLINED';
  return 'UNANSWERED';
}

const WITHIN_30_MIN = 30;
const WITHIN_24_H = 24 * 60;

const ratio = (part: number, whole: number) =>
  whole === 0 ? null : part / whole;

/** Una cita recuperada: su valor (ítems del plan ligados), por moneda. */
export type FillerValues = ReadonlyMap<string, readonly MoneyAmount[]>;

/**
 * Las métricas de un conjunto de huecos (ya emparejados), conteos de citas y
 * de ofertas. El valor de cada cita recuperada se suma UNA vez (en el primer
 * hueco al que aporta); un hueco recuperado es «sin valorar» si ninguna de
 * sus citas tiene ítems del plan ligados.
 */
export function buildMetrics(
  outcomes: readonly SlotOutcome[],
  counts: readonly AppointmentDayCount[],
  offers: readonly OfferDayCount[],
  values: FillerValues,
  valuedOnce: ReadonlySet<string>,
): RecoveredSlotsMetrics {
  const recovered = outcomes.filter((o) => o.fill !== 'OPEN');
  const freed = outcomes.length;
  const amounts = new Map<string, number>();
  let unvalued = 0;
  for (const o of recovered) {
    const valued = o.fillerIds.some((id) => (values.get(id)?.length ?? 0) > 0);
    if (!valued) unvalued++;
    for (const id of o.fillerIds) {
      if (!valuedOnce.has(`${o.slot.id}|${id}`)) continue;
      for (const v of values.get(id) ?? []) {
        amounts.set(v.currency, (amounts.get(v.currency) ?? 0) + v.amount);
      }
    }
  }
  const toFill = recovered
    .map((o) => o.minutesToFill)
    .filter((m): m is number => m !== null);
  const scheduled = counts.reduce((s, c) => s + c.scheduled, 0);
  const cancelled = counts.reduce((s, c) => s + c.cancelled, 0);
  const offerSum = (bucket: OfferOutcomeBucket) =>
    offers.filter((o) => o.outcome === bucket).reduce((s, o) => s + o.count, 0);
  const accepted = offerSum('ACCEPTED');
  const declined = offerSum('DECLINED');
  const unanswered = offerSum('UNANSWERED');
  return {
    freedSlots: freed,
    freedMinutes: outcomes.reduce((s, o) => s + o.freedMinutes, 0),
    filledSlots: recovered.filter((o) => o.fill === 'FILLED').length,
    partiallyFilledSlots: recovered.filter((o) => o.fill === 'PARTIAL').length,
    recoveredMinutes: recovered.reduce((s, o) => s + o.recoveredMinutes, 0),
    filledByListSlots: recovered.filter((o) => o.byList).length,
    fillRate: ratio(recovered.length, freed),
    filledWithin30MinRate: ratio(
      toFill.filter((m) => m <= WITHIN_30_MIN).length,
      freed,
    ),
    filledWithin24hRate: ratio(
      toFill.filter((m) => m <= WITHIN_24_H).length,
      freed,
    ),
    meanMinutesToFill:
      toFill.length === 0
        ? null
        : toFill.reduce((s, m) => s + m, 0) / toFill.length,
    cancellationRate: ratio(cancelled, scheduled),
    offers: {
      sent: accepted + declined + unanswered,
      accepted,
      declined,
      unanswered,
    },
    recoveredValue: [...amounts.entries()]
      .map(([currency, amount]) => ({ currency, amount: round2(amount) }))
      .sort((a, b) => byText(a.currency, b.currency)),
    unvaluedRecoveredSlots: unvalued,
  };
}

/**
 * A qué hueco se suma el valor de cada cita: al primero (en el orden del
 * emparejamiento) al que aporta minutos. Claves `hueco|cita`.
 */
export function valueAttribution(
  outcomes: readonly SlotOutcome[],
): Set<string> {
  const seen = new Set<string>();
  const keys = new Set<string>();
  for (const o of outcomes) {
    for (const id of o.fillerIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      keys.add(`${o.slot.id}|${id}`);
    }
  }
  return keys;
}
