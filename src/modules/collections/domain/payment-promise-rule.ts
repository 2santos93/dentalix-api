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
 * - KEPT (cumplido) si esos abonos suman al menos el importe (en centavos).
 * - BROKEN (incumplido) si no, desde el día SIGUIENTE al del compromiso en esa
 *   zona (un compromiso «para el 15/11» se incumple el 16/11 a las 00:00 de la
 *   sede).
 * - Si no, sigue OPEN. Cumplido se evalúa antes: un barrido tardío del 16 con
 *   abonos del 15 lo da por cumplido.
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

export function evaluatePromise(
  terms: PromiseTerms,
  payments: readonly PromisePayment[],
  options: EvaluateOptions,
): PromiseEvaluation {
  let coveredCents = 0;
  for (const p of payments) {
    if (p.currency !== terms.currency) continue;
    if (p.createdAt.getTime() < terms.createdAt.getTime()) continue;
    if (civilDateIn(p.paidAt, options.timeZone) > terms.dueDate) continue;
    coveredCents += toCents(p.amount);
  }
  const covered = fromCents(coveredCents);
  if (coveredCents >= toCents(terms.amount)) {
    return { status: 'KEPT', covered };
  }
  const today = civilDateIn(options.now, options.timeZone);
  return { status: today > terms.dueDate ? 'BROKEN' : 'OPEN', covered };
}
