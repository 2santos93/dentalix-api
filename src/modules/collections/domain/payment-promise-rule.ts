import { civilDateIn } from '../../../shared/time/civil-day';
import { fromCents, toCents } from '../../receivables/domain/aging';

/*
 * Regla de un compromiso de pago (DX-150). Pura: la usan el barrido de
 * cobranza (tarea programada de DX-085), el cierre al registrar un abono y la
 * ficha (para mostrar cuánto se ha cubierto).
 *
 * - CUENTAN los abonos VIVOS del paciente en la MONEDA del compromiso,
 *   registrados DESDE que se hizo el compromiso (`createdAt` del abono ≥ el
 *   del compromiso: un abono anterior ya estaba en el saldo con el que se
 *   pactó) y fechados (`paidAt`) hasta el día del compromiso INCLUSIVE, en
 *   días civiles de la zona de la sede del compromiso (DX-097).
 * - Las dos altas (`createdAt` del abono y del compromiso) vienen de la MISMA
 *   fuente de hora (DX-226): las pone el servidor de BD en UTC con un trigger
 *   BEFORE INSERT (`timezone('UTC', now())`), ignorando lo que mande la API.
 *   Así ni la zona de la sesión ni un reloj de la API desfasado unos segundos
 *   respecto de la BD hacen pasar por posterior un abono registrado antes del
 *   compromiso (ni al revés). Se eligió esto y no comparar por día civil
 *   (`paidAt` ≥ día de alta del compromiso) porque el día civil daría por
 *   bueno un abono registrado horas antes del compromiso el mismo día, que ya
 *   estaba en el saldo con el que se pactó. `now` (el reloj del barrido) solo
 *   decide el día en que se incumple, que es de grano diario.
 * - KEPT (cumplido) si esos abonos suman al menos el importe (en centavos).
 * - BROKEN (incumplido) si no, desde el día SIGUIENTE al del compromiso en esa
 *   zona (un compromiso «para el 15/11» se incumple el 16/11 a las 00:00 de la
 *   sede).
 * - Si no, sigue OPEN. Cumplido se evalúa antes: un barrido tardío del 16 con
 *   abonos del 15 lo da por cumplido.
 * - DX-215: anular un abono que contaba para el último compromiso CUMPLIDO del
 *   paciente en su moneda lo vuelve a evaluar con los abonos que siguen vivos
 *   (`statusAfterVoid`): sigue KEPT si aún lo cubren; si no, OPEN mientras no
 *   pase su día o BROKEN desde el siguiente. Si el paciente ya tiene OTRO
 *   compromiso abierto (uno solo por paciente), queda BROKEN: el vigente es el
 *   nuevo.
 */

export type PromiseStatus = 'OPEN' | 'KEPT' | 'BROKEN';

export interface PromiseTerms {
  amount: number;
  currency: string;
  /** Día civil (YYYY-MM-DD) en la zona de la sede. */
  dueDate: string;
  createdAt: Date;
}

/** Un abono vivo del paciente (los anulados o borrados no llegan aquí). */
export interface PromisePayment {
  amount: number;
  currency: string;
  paidAt: Date;
  createdAt: Date;
}

export interface PromiseEvaluation {
  status: PromiseStatus;
  /** Lo que los abonos que cuentan han cubierto (puede pasar del importe). */
  covered: number;
}

export interface EvaluateOptions {
  now: Date;
  /** Zona IANA de la sede del compromiso. */
  timeZone: string;
}

/** ¿Cuenta este abono (vivo) para el compromiso? Moneda, alta y día civil. */
export function countsTowardPromise(
  terms: PromiseTerms,
  payment: PromisePayment,
  timeZone: string,
): boolean {
  return (
    payment.currency === terms.currency &&
    payment.createdAt.getTime() >= terms.createdAt.getTime() &&
    civilDateIn(payment.paidAt, timeZone) <= terms.dueDate
  );
}

export function evaluatePromise(
  terms: PromiseTerms,
  payments: readonly PromisePayment[],
  options: EvaluateOptions,
): PromiseEvaluation {
  let coveredCents = 0;
  for (const p of payments) {
    if (countsTowardPromise(terms, p, options.timeZone)) {
      coveredCents += toCents(p.amount);
    }
  }
  const covered = fromCents(coveredCents);
  if (coveredCents >= toCents(terms.amount)) {
    return { status: 'KEPT', covered };
  }
  const today = civilDateIn(options.now, options.timeZone);
  return { status: today > terms.dueDate ? 'BROKEN' : 'OPEN', covered };
}

export interface AfterVoidOptions extends EvaluateOptions {
  /** El paciente ya tiene otro compromiso OPEN (índice único por paciente). */
  anotherOpen: boolean;
}

/**
 * Estado de un compromiso CUMPLIDO tras anular un abono que contaba para él
 * (DX-215). `payments`: los abonos que siguen vivos.
 */
export function statusAfterVoid(
  terms: PromiseTerms,
  payments: readonly PromisePayment[],
  options: AfterVoidOptions,
): PromiseStatus {
  const { status } = evaluatePromise(terms, payments, options);
  return status === 'OPEN' && options.anotherOpen ? 'BROKEN' : status;
}
