import {
  ClinicRole,
  type ClosingDismissalReason,
  type ClosingQueueSection,
} from '@prisma/client';
import {
  addCivilDays,
  checkPeriodDays,
  civilDateIn,
  civilDaysInclusive,
  zonedStartOfDay,
  type ZonedPeriodBranch,
} from '../../../shared/time/civil-day';

/**
 * «Pendiente de cerrar» (DX-439): lo que quedó sin cerrar de días ANTERIORES
 * a hoy, en la zona de la sede de cada cita.
 *
 *  - OUTCOME: citas en SCHEDULED o CONFIRMED (sin desenlace);
 *  - EVOLUTION: citas COMPLETED sin ninguna evolución viva ligada;
 *  - TREATMENT: citas COMPLETED con un ítem ligado que sigue en ACCEPTED y no
 *    lo reserva ni lo atendió después otra cita.
 */
export const CLOSING_QUEUE_SECTIONS: readonly ClosingQueueSection[] = [
  'OUTCOME',
  'EVOLUTION',
  'TREATMENT',
];

/** Días hacia atrás (hasta ayer) cuando no se pide un período. */
export const CLOSING_QUEUE_DEFAULT_DAYS = 14;
/** Tope del período pedido, en días civiles. */
export const CLOSING_QUEUE_MAX_DAYS = 92;
/** Tope de filas por sección (el recuento sigue siendo exacto). */
export const CLOSING_QUEUE_SECTION_LIMIT = 200;

/** Texto obligatorio del motivo «Otro». */
export const DISMISSAL_TEXT_MIN = 3;
export const DISMISSAL_TEXT_MAX = 200;

/**
 * Qué secciones ve cada rol: el desenlace de la cita es del mostrador
 * (RECEPTION) y la clínica (evolución y tratamiento), del odontólogo; ADMIN
 * ve todo. La asistente no tiene lista propia.
 */
export function sectionsFor(role: ClinicRole): ClosingQueueSection[] {
  switch (role) {
    case ClinicRole.ADMIN:
      return [...CLOSING_QUEUE_SECTIONS];
    case ClinicRole.DENTIST:
      return ['EVOLUTION', 'TREATMENT'];
    case ClinicRole.RECEPTION:
      return ['OUTCOME'];
    default:
      return [];
  }
}

export interface ClosingActor {
  userId: string;
  role: ClinicRole;
}

/**
 * El profesional de la lista: un DENTIST solo ve sus citas (pedir las de otro
 * es un `ok: false`, 403); el resto filtra por quien pida, o por nadie.
 */
export function closingProfessional(
  actor: ClosingActor,
  requested: string | undefined,
): { ok: true; professionalId?: string } | { ok: false } {
  if (actor.role === ClinicRole.DENTIST) {
    if (requested !== undefined && requested !== actor.userId) {
      return { ok: false };
    }
    return { ok: true, professionalId: actor.userId };
  }
  return requested === undefined
    ? { ok: true }
    : { ok: true, professionalId: requested };
}

export type ClosingPeriodCheck =
  | { ok: true; from?: string; to?: string }
  | { ok: false; problem: 'INVALID' | 'OUT_OF_RANGE' | 'TOO_LONG' };

/**
 * El período pedido (ambos opcionales), como mucho `CLOSING_QUEUE_MAX_DAYS`
 * días. Con los dos, desde ≤ hasta; con solo «desde», el «hasta» es ayer
 * (`today` − 1) y el tope se mide contra él, para que no se salte omitiendo
 * «hasta». Con solo «hasta», el «desde» por defecto es 14 días antes.
 */
export function checkClosingPeriod(
  from: string | undefined,
  to: string | undefined,
  today: string,
): ClosingPeriodCheck {
  if (from === undefined && to === undefined) return { ok: true };
  const check = checkPeriodDays(from ?? to!, to ?? from!);
  if (!check.ok) return { ok: false, problem: check.problem };
  const last = to !== undefined ? check.to : addCivilDays(today, -1);
  if (
    from !== undefined &&
    last >= check.from &&
    civilDaysInclusive(check.from, last) > CLOSING_QUEUE_MAX_DAYS
  ) {
    return { ok: false, problem: 'TOO_LONG' };
  }
  return {
    ok: true,
    ...(from !== undefined ? { from: check.from } : {}),
    ...(to !== undefined ? { to: check.to } : {}),
  };
}

/**
 * Los instantes `[inicio, fin)` de la lista, una rama por ZONA (como los
 * reportes, DX-097): en cada zona «hoy» es su día civil en `now`; «hasta»
 * nunca pasa de ayer, así que una cita de hoy no sale nunca, y sin «desde» se
 * miran los `CLOSING_QUEUE_DEFAULT_DAYS` días que acaban en «hasta». Una zona en la que el
 * período queda vacío (empieza hoy o después) no deja rama.
 */
export function closingWindow(
  now: Date,
  zoneByLocation: ReadonlyMap<string, string>,
  period: { from?: string; to?: string },
  /** Tope de días de la rama (la lista); sin él, sin tope (el descarte). */
  maxDays?: number,
): ZonedPeriodBranch[] {
  const byZone = new Map<string, string[]>();
  for (const [locationId, timeZone] of zoneByLocation) {
    byZone.set(timeZone, [...(byZone.get(timeZone) ?? []), locationId]);
  }
  return [...byZone.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([timeZone, locationIds]) => {
      const today = civilDateIn(now, timeZone);
      const yesterday = addCivilDays(today, -1);
      const to =
        period.to !== undefined && period.to < yesterday
          ? period.to
          : yesterday;
      // Sin «desde»: los 14 días que acaban en «hasta».
      const requested =
        period.from ?? addCivilDays(to, -(CLOSING_QUEUE_DEFAULT_DAYS - 1));
      // El tope se aplica en la zona de la rama («hoy» cambia de una a otra).
      const floor =
        maxDays !== undefined ? addCivilDays(to, -(maxDays - 1)) : requested;
      const from = requested < floor ? floor : requested;
      if (from > to) return [];
      return [
        {
          timeZone,
          locationIds: [...locationIds].sort(),
          start: zonedStartOfDay(from, timeZone),
          end: zonedStartOfDay(addCivilDays(to, 1), timeZone),
        },
      ];
    });
}

export interface DismissalInput {
  section: ClosingQueueSection;
  appointmentId: string;
  planItemId?: string | null;
  reasonCode: ClosingDismissalReason;
  reasonText?: string | null;
}

export interface Dismissal {
  section: ClosingQueueSection;
  appointmentId: string;
  planItemId: string | null;
  reasonCode: ClosingDismissalReason;
  reasonText: string | null;
}

export type DismissalProblem =
  'REASON_TEXT' | 'PLAN_ITEM_REQUIRED' | 'PLAN_ITEM_NOT_ALLOWED';

/**
 * Un descarte bien formado: el ítem va solo y siempre en TREATMENT, y el texto
 * solo con «Otro» (3–200 sin contar los espacios de los bordes); con otro
 * motivo el texto no se guarda.
 */
export function checkDismissal(
  input: DismissalInput,
): { ok: true; value: Dismissal } | { ok: false; problem: DismissalProblem } {
  const planItemId = input.planItemId ?? null;
  if (input.section === 'TREATMENT' && planItemId === null) {
    return { ok: false, problem: 'PLAN_ITEM_REQUIRED' };
  }
  if (input.section !== 'TREATMENT' && planItemId !== null) {
    return { ok: false, problem: 'PLAN_ITEM_NOT_ALLOWED' };
  }
  let reasonText: string | null = null;
  if (input.reasonCode === 'OTHER') {
    const text = (input.reasonText ?? '').trim();
    // Caracteres (puntos de código), como `char_length` del CHECK de la BD.
    const length = [...text].length;
    if (length < DISMISSAL_TEXT_MIN || length > DISMISSAL_TEXT_MAX) {
      return { ok: false, problem: 'REASON_TEXT' };
    }
    reasonText = text;
  }
  return {
    ok: true,
    value: {
      section: input.section,
      appointmentId: input.appointmentId,
      planItemId,
      reasonCode: input.reasonCode,
      reasonText,
    },
  };
}
