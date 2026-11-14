import type { PlanBalanceInput } from '../../payments/application/use-cases/get-plan-balance.use-case';
import { civilDateIn } from '../../../shared/time/civil-day';
import type { PatientLedger } from '../domain/entities/receivables.entity';
import { fromCents, toCents } from '../domain/aging';

/**
 * DX-472-bis: lo que `PlanBalanceCalculator` necesita para contar, convertido,
 * lo abonado en otra moneda a los planes de estas carteras. Solo los planes
 * con abonos en otra moneda (los demás no cambian de cifra): sin ellos, el
 * cálculo no hace nada.
 *
 * - Lo ya en la moneda del plan va sumado (`paidKnown`): sus abonos, sus
 *   asientos de saldo a favor (el resumen los suma a lo abonado, DX-253) y
 *   las bases de los abonos en otra moneda.
 * - Los abonos en otra moneda aún sin base van uno a uno, con su tasa
 *   congelada si la tienen, y su día civil en la zona de su sede (DX-097):
 *   el calculador los convierte como en `/balance`, sin red si la tasa está
 *   congelada.
 */
export function ledgerPlanBalanceInputs(
  ledgers: readonly PatientLedger[],
  zoneOf: (locationId: string | null) => string,
): PlanBalanceInput[] {
  const inputs: PlanBalanceInput[] = [];
  for (const ledger of ledgers) {
    for (const plan of ledger.plans) {
      const other = plan.otherCurrency;
      if (!other) continue;
      let knownCents = toCents(other.based);
      for (const p of ledger.paid) {
        if (p.treatmentPlanId === plan.id && p.currency === plan.currency) {
          knownCents += toCents(p.amount);
        }
      }
      inputs.push({
        plan: { id: plan.id, status: plan.status, currency: plan.currency },
        items: [],
        billable: plan.billable,
        paidKnown: fromCents(knownCents),
        payments: other.pending.map((p) => ({
          id: p.id,
          amount: p.amount,
          currency: p.currency,
          paidOn: civilDateIn(p.paidAt, zoneOf(p.locationId)),
          exchangeRateCurrency: p.exchangeRateCurrency,
          frozenRate: p.frozenRate,
        })),
        baseOf: new Map(),
        creditMovements: 0,
      });
    }
  }
  return inputs;
}
