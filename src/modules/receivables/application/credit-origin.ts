import type {
  OriginPayment,
  PlanCreditFacts,
  PlanCreditOrigin,
} from '../domain/entities/credit-balances.entity';

/*
 * REGLA (DX-430, ronda 1): de dónde viene el saldo a favor de UN plan.
 *
 * - ABONO ORIGEN: el que lo creó. Se recorren los abonos vivos del plan por
 *   orden cronológico (paidAt, luego id) sumando lo que cuenta en la moneda
 *   del plan; el origen es el PRIMERO que deja lo abonado por encima de lo
 *   facturable (en un plan cancelado o rechazado el facturable es 0: el primer
 *   abono). Los siguientes solo aumentan el exceso. Si nunca lo supera (el
 *   exceso viene de un traspaso recibido o de una conversión pendiente) o el
 *   plan no tiene abonos propios, se toma el último abono propio o, sin ellos,
 *   el más antiguo de los planes de los que vino el saldo por traspaso.
 * - SEDE: la del propio plan (donde se aceptó o, si no, se presentó); si el
 *   plan no tiene, la del abono origen. Es la sede donde está el dinero, no
 *   donde el paciente tuvo su última cita.
 * - ANTIGÜEDAD: la fecha del abono origen, en el día civil de SU sede.
 */
export function originOfPlanCredit(
  facts: PlanCreditFacts,
  billableCents: number,
): PlanCreditOrigin {
  const payment = originPayment(facts, billableCents);
  return {
    locationId: facts.planLocationId ?? payment?.locationId ?? null,
    payment,
  };
}

function originPayment(
  facts: PlanCreditFacts,
  billableCents: number,
): OriginPayment | null {
  const own = facts.ownPayments;
  if (own.length > 0) {
    let cumulative = 0;
    for (const p of own) {
      cumulative += p.planCents ?? 0;
      if (cumulative > billableCents) return p;
    }
    return own[own.length - 1];
  }
  return facts.transferredPayments[0] ?? null;
}
