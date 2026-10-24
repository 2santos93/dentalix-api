import { AppointmentStatus } from '@prisma/client';
import { isInClinic } from './patient-flow';
import { civilDateIn } from '../../../shared/time/civil-day';

/**
 * DX-271 (BE-039): los ítems del plan de una cita cerrada o pasada no se
 * cambian. Es lo que se hizo (o se iba a hacer) en esa visita y fija el
 * intervalo mínimo de la siguiente (DX-256). Mismo texto que el trigger
 * `dx271_completed_link_guard` (ERRCODE DX271).
 */
export const PLAN_ITEMS_CLOSED_MESSAGE =
  'Esta cita ya pasó: sus tratamientos no se cambian.';
/** Una cita futura cancelada no «ya pasó»: se dice su estado. */
export const PLAN_ITEMS_CANCELLED_MESSAGE =
  'Esta cita está cancelada: sus tratamientos no se cambian.';
/** Ídem para una cita futura marcada «no asistió». */
export const PLAN_ITEMS_NO_SHOW_MESSAGE =
  'Esta cita está marcada como «no asistió»: sus tratamientos no se cambian.';
/**
 * El ítem está reservado en una cita de una sede que el usuario no tiene
 * permitida (DX-089): no se enseña su fecha ni su sede.
 */
export const PLAN_ITEM_RESERVED_OTHER_LOCATION_MESSAGE =
  'Este tratamiento ya está reservado en otra cita de otra sede. Pide en esa sede que lo quiten de esa cita o la cancelen.';

/** DX-273 «Traer a esta cita»: la cita destino no está en la clínica. */
export const PLAN_ITEM_CLAIM_NOT_IN_CLINIC_MESSAGE =
  'Solo se trae un tratamiento a una cita con el paciente en la clínica (llegó, en sillón o listo para cobrar).';
/**
 * DX-288: el tratamiento ya lo reserva otra cita de hoy con el paciente en
 * la clínica. Mientras esa cita siga en curso nadie se lo lleva: con varias
 * peticiones a la vez, solo la primera lo trae. Texto general, sin datos de
 * la cita (su sede no está permitida al usuario, DX-089).
 */
export const PLAN_ITEM_CLAIM_HELD_IN_CLINIC_MESSAGE =
  'Este tratamiento ya lo tiene otra cita con el paciente en la clínica. No se puede traer mientras esa cita siga en curso.';

/**
 * DX-288 (revisión M1): ¿la cita que reserva el tratamiento impide
 * traerlo? Solo si tiene al paciente en la clínica y es del mismo día civil
 * que `now` en la zona de SU sede (DX-097). Una cita olvidada en la clínica
 * de un día anterior no lo impide: se trae normalmente.
 */
export function heldInClinicToday(
  holder: { status: AppointmentStatus; start: Date },
  timeZone: string,
  now: Date,
): boolean {
  return (
    isInClinic(holder.status) &&
    civilDateIn(holder.start, timeZone) === civilDateIn(now, timeZone)
  );
}

/**
 * El 409 de una titular en la clínica: con su hora (en la zona de su sede)
 * y su sede si el usuario la tiene permitida; sin ella (`null`), el general.
 */
export function heldInClinicMessage(
  holder: { start: Date; timeZone: string; locationName: string } | null,
): string {
  if (!holder) return PLAN_ITEM_CLAIM_HELD_IN_CLINIC_MESSAGE;
  const time = new Intl.DateTimeFormat('es-CO', {
    timeZone: holder.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(holder.start);
  return `Este tratamiento ya lo tiene otra cita con el paciente en la clínica, la de hoy a las ${time} (${holder.locationName}). No se puede traer mientras esa cita siga en curso.`;
}
/** DX-273: el tratamiento no está (vivo) en la cita destino. */
export const PLAN_ITEM_CLAIM_NOT_LINKED_MESSAGE =
  'Este tratamiento no está en esta cita.';

const CLOSED_STATUSES: ReadonlySet<AppointmentStatus> = new Set([
  AppointmentStatus.COMPLETED,
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
]);

/**
 * ¿La cita ya no admite cambios en sus ítems? Completada, cancelada o no-show;
 * o agendada/confirmada que ya empezó sin que el paciente llegara. Con el
 * paciente en la clínica sigue abierta.
 */
export function closedForPlanItems(
  appointment: { status: AppointmentStatus; start: Date },
  now: Date,
): boolean {
  if (CLOSED_STATUSES.has(appointment.status)) return true;
  if (isInClinic(appointment.status)) return false;
  return appointment.start.getTime() < now.getTime();
}

/**
 * El 409 de una cita cerrada: completada o ya pasada, «ya pasó»; cancelada o
 * no-show todavía futura, su estado.
 */
export function planItemsClosedMessage(
  appointment: { status: AppointmentStatus; start: Date },
  now: Date,
): string {
  if (appointment.start.getTime() >= now.getTime()) {
    if (appointment.status === AppointmentStatus.CANCELLED)
      return PLAN_ITEMS_CANCELLED_MESSAGE;
    if (appointment.status === AppointmentStatus.NO_SHOW)
      return PLAN_ITEMS_NO_SHOW_MESSAGE;
  }
  return PLAN_ITEMS_CLOSED_MESSAGE;
}

/**
 * ¿Se pueden cambiar los ítems en este PATCH? Basta con que la cita esté
 * abierta antes o después del cambio: reactivar una cancelada futura y
 * cambiarle los ítems, o ajustarlos al cobrar (en la clínica → completada),
 * sí; tocar los de una cita que sigue cerrada, no.
 */
export function planItemsEditable(
  before: { status: AppointmentStatus; start: Date },
  after: { status: AppointmentStatus; start: Date },
  now: Date,
): boolean {
  return !closedForPlanItems(before, now) || !closedForPlanItems(after, now);
}

/**
 * DX-271 (BE-038): el 409 de reserva dice en qué cita está el ítem, con la
 * fecha y la hora en la zona de la sede de ESA cita: «… en otra cita, la del
 * 30/10/2026 a las 09:00. …». Sin la cita (se liberó a la vez), el general.
 */
export function reservedElsewhereMessage(
  start: Date | null,
  timeZone: string,
): string {
  const advice = 'Quítalo de esa cita o cancélala antes.';
  if (!start)
    return `Este tratamiento ya está reservado en otra cita. ${advice}`;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('es-CO', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(start)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return `Este tratamiento ya está reservado en otra cita, la del ${p.day}/${p.month}/${p.year} a las ${p.hour}:${p.minute}. ${advice}`;
}
