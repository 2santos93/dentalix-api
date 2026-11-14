import {
  BillablePlan,
  BillablePlanRow,
} from '../domain/entities/billable-plan.entity';
import { isPlanBillable } from '../../treatment-plans/domain/plan-status-machine';
import { fromCents, toCents } from '../../../shared/money/money';
import type { PlanBalances } from './compute-account-statement';

/**
 * Qué planes se le ofrecen a quien cobra y con qué cifras (DX-067). Mismos
 * criterios que el estado de cuenta (`computeAccountStatement`), para que el
 * saldo del modal sea el que se ve en la tabla «Planes»:
 *
 * - Un plan CANCELLED o REJECTED (DX-040) no se cobra: fuera.
 * - Un plan sin nada facturable (solo ítems PROPOSED, o sin ítems) todavía no
 *   se debe: fuera.
 * - Abonado y saldo = los de `/balance` (DX-472-bis, `planBalances`): lo
 *   abonado en otra moneda cuenta convertido a la del plan, con su tasa; lo
 *   que no tiene tasa no suma y se informa (`paymentsWithoutRate`). Los
 *   asientos del saldo a favor (DX-253) suman a lo abonado. Lo entregado en
 *   otra moneda se informa además tal cual (`paidOtherCurrencies`). Sin el
 *   saldo de un plan, solo cuenta lo abonado en su moneda (como antes).
 */
export function computeBillablePlans(
  rows: BillablePlanRow[],
  planBalances?: PlanBalances,
): BillablePlan[] {
  return rows
    .filter((row) => isPlanBillable(row.status) && toCents(row.billable) > 0)
    .map((row) => {
      const totalCents = toCents(row.billable);
      const known = planBalances?.get(row.id);
      const paidCents = known
        ? toCents(known.paid) + toCents(known.creditMovements)
        : row.paidByCurrency
            .filter((p) => p.currency === row.currency)
            .reduce((sum, p) => sum + toCents(p.amount), 0);
      return {
        id: row.id,
        status: row.status,
        currency: row.currency,
        createdAt: row.createdAt,
        total: fromCents(totalCents),
        paid: fromCents(paidCents),
        paidOtherCurrencies: row.paidByCurrency
          .filter((p) => p.currency !== row.currency)
          .sort((a, b) => a.currency.localeCompare(b.currency))
          .map((p) => ({
            currency: p.currency,
            amount: fromCents(toCents(p.amount)),
          })),
        balance: known?.balance ?? fromCents(totalCents - paidCents),
        hasActivePaymentPlan: row.hasActivePaymentPlan,
        paymentsWithoutRate: known?.paymentsWithoutRate ?? [],
        rateProviderTimedOut: known?.rateProviderTimedOut ?? false,
      };
    });
}
