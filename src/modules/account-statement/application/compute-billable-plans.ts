import {
  BillablePlan,
  BillablePlanRow,
} from '../domain/entities/billable-plan.entity';
import { isPlanBillable } from '../../treatment-plans/domain/plan-status-machine';

// Montos Decimal(14,2): sumar en centavos enteros es exacto (mismo criterio que
// computeAccountStatement).
function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function fromCents(cents: number): number {
  return cents / 100;
}

/**
 * Qué planes se le ofrecen a quien cobra y con qué cifras (DX-067). Mismos
 * criterios que el estado de cuenta (`computeAccountStatement`), para que el
 * saldo del modal sea el que se ve en la tabla «Planes»:
 *
 * - Un plan CANCELLED o REJECTED (DX-040) no se cobra: fuera.
 * - Un plan sin nada facturable (solo ítems PROPOSED, o sin ítems) todavía no
 *   se debe: fuera.
 * - Abonado = abonos vivos en la moneda del plan; los de otra moneda van aparte
 *   y no se convierten (no descuentan el saldo).
 */
export function computeBillablePlans(rows: BillablePlanRow[]): BillablePlan[] {
  return rows
    .filter((row) => isPlanBillable(row.status) && toCents(row.billable) > 0)
    .map((row) => {
      const totalCents = toCents(row.billable);
      const paidCents = row.paidByCurrency
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
        balance: fromCents(totalCents - paidCents),
        hasActivePaymentPlan: row.hasActivePaymentPlan,
      };
    });
}
