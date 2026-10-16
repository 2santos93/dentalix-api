import { ClinicRole } from '@prisma/client';

/**
 * Día civil (YYYY-MM-DD) de un instante en una zona IANA. `en-CA` formatea
 * fechas como `2026-10-16`, así que el resultado se compara como texto.
 */
export function civilDateIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * ¿Caen `a` y `b` en el MISMO día del calendario de la sede? Es la ventana en
 * la que recepción puede anular un abono suyo (SEC-013): el "hoy" de la caja
 * que se arquea en esa sede, no el día UTC del servidor.
 */
export function isSameCivilDay(a: Date, b: Date, timeZone: string): boolean {
  return civilDateIn(a, timeZone) === civilDateIn(b, timeZone);
}

/** Lo que la regla necesita saber del abono: autor, alta y zona de su sede. */
export interface VoidSubject {
  createdById: string | null;
  createdAt: Date;
  /** IANA de la sede del abono (su horario), o la zona por defecto. */
  timeZone: string;
}

/** Quién quiere anular: SIEMPRE del token, nunca del cliente. */
export interface VoidActor {
  userId: string;
  role: ClinicRole;
}

export type VoidDenial = 'NOT_AUTHOR' | 'NOT_SAME_DAY';

/**
 * SEC-013: ADMIN anula cualquier abono. Cualquier otro rol con acceso a pagos
 * (hoy solo RECEPTION) únicamente los que registró ÉL MISMO y en el MISMO día
 * de la sede. Un abono sin autor (legado) es solo de ADMIN. `null` = permitido.
 *
 * Es la ÚNICA definición de la regla: la aplica `VoidPaymentUseCase` (403) y la
 * usan la caja y el estado de cuenta para calcular `canVoid` (DX-057), así la
 * web nunca enseña «Anular» donde el servidor diría que no.
 */
export function voidDenial(
  subject: VoidSubject,
  actor: VoidActor,
  now: Date,
): VoidDenial | null {
  if (actor.role === ClinicRole.ADMIN) {
    return null;
  }
  if (subject.createdById === null || subject.createdById !== actor.userId) {
    return 'NOT_AUTHOR';
  }
  if (!isSameCivilDay(subject.createdAt, now, subject.timeZone)) {
    return 'NOT_SAME_DAY';
  }
  return null;
}

export function canVoidPayment(
  subject: VoidSubject,
  actor: VoidActor,
  now: Date,
): boolean {
  return voidDenial(subject, actor, now) === null;
}
