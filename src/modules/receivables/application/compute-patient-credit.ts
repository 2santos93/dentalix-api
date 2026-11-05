import {
  computeBalances,
  type PlanBalances,
  type RoundingDigitsOf,
} from '../../account-statement/application/compute-account-statement';
import { roundToDigits } from '../../../shared/money/line-rounding';
import { fromCents, toCents } from '../domain/aging';
import type { PlanCredit } from '../domain/entities/credit-balances.entity';
import type { PatientLedger } from '../domain/entities/receivables.entity';

export interface ComputePatientCreditOptions {
  /** «Hoy» (inyectado, nunca el reloj): solo para los estados de cuota que `computeBalances` deriva. */
  now: Date;
  /** DX-472-bis: el saldo de los planes con abonos en otra moneda; sin él, sin convertir. */
  planBalances?: PlanBalances;
  /** B4: decimales de cada moneda: un residuo de la conversión que la moneda no tiene no es saldo. */
  roundingDigitsOf?: RoundingDigitsOf;
}

/*
 * CRITERIO (DX-430, REGLA DE ORO): el saldo a favor de la lista NO tiene
 * fórmula propia. Es el del estado de cuenta: `computeBalances` (el mismo
 * núcleo que GET /patients/:id/account-statement y que la cartera por
 * antigüedad) da el `balance` de cada plan, y el saldo a favor de un plan es
 * `-balance` cuando es negativo (abonado de más, o plan cancelado/rechazado
 * con abonos, descontados traspasos y devoluciones). Es la misma cifra que
 * `planCreditCents` (DX-253) pone como tope de un traspaso o una devolución.
 * Devuelve una línea por plan (la sede se atribuye por plan); por moneda es la
 * suma de sus líneas. Un plan con deuda NO lo compensa (el traspaso a ese plan es justo para lo que sirve el saldo).
 */
export function computePatientCredit(
  ledger: PatientLedger,
  options: ComputePatientCreditOptions,
): PlanCredit[] {
  const balances = computeBalances(
    {
      plans: ledger.plans,
      payments: ledger.paid.map((p) => ({ ...p, voidedAt: null })),
      paymentPlans: ledger.paymentPlans,
      openingBalances: ledger.openings,
    },
    options.now,
    options.planBalances,
    options.roundingDigitsOf,
  );
  const credits: PlanCredit[] = [];
  for (const line of balances.plans) {
    const balanceCents = toCents(line.balance);
    if (balanceCents >= 0) continue;
    // B4: lo que la moneda no tiene (¥0,13 tras convertir) no es saldo.
    if (
      roundToDigits(
        fromCents(-balanceCents),
        options.roundingDigitsOf?.(line.currency) ?? 2,
      ) <= 0
    ) {
      continue;
    }
    credits.push({
      planId: line.id,
      currency: line.currency,
      creditCents: -balanceCents,
    });
  }
  return credits;
}
