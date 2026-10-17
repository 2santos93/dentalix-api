import type { PatientAging } from '../../receivables/domain/entities/receivables.entity';
import { fromCents, toCents } from '../../receivables/domain/aging';

/*
 * Marca «Saldo vencido» de la agenda y de la cabecera de la ficha (DX-150).
 * Sale de la MISMA antigüedad que la cartera (DX-145, `computePatientAging`):
 * el paciente tiene saldo vencido si alguna parte de su deuda es exigible
 * desde hace al menos un día civil de la zona de la sede de la deuda (una
 * cuota vencida, o el saldo de un plan sin cuotas desde su aceptación). El
 * mismo día en que se acepta un plan no cuenta.
 *
 * El importe (lo exigible por moneda, sin «por vencer») solo lo reciben ADMIN
 * y RECEPTION; DENTIST y ASSISTANT ven la marca y los días.
 */

export interface OverdueAmount {
  currency: string;
  amount: number;
}

export interface OverdueBalance {
  hasOverdue: boolean;
  /** Días de la deuda vencida más antigua; `null` si no hay. */
  overdueDays: number | null;
  /** Solo para los roles que ven importes (y solo si hay saldo vencido). */
  amounts?: OverdueAmount[];
}

export const NO_OVERDUE: OverdueBalance = Object.freeze({
  hasOverdue: false,
  overdueDays: null,
});

export function overdueOf(aging: PatientAging): {
  hasOverdue: boolean;
  overdueDays: number | null;
  amounts: OverdueAmount[];
} {
  const days = aging.oldestAgeDays;
  if (days === null || days < 1) {
    return { hasOverdue: false, overdueDays: null, amounts: [] };
  }
  const amounts = aging.currencies
    .map((c) => ({
      currency: c.currency,
      amount: fromCents(
        toCents(c.buckets.days0to30) +
          toCents(c.buckets.days31to60) +
          toCents(c.buckets.days61to90) +
          toCents(c.buckets.over90),
      ),
    }))
    .filter((a) => a.amount > 0);
  return { hasOverdue: true, overdueDays: days, amounts };
}

/** Lo que ve cada rol: la marca siempre; el importe, solo si `withAmounts`. */
export function overdueView(
  aging: PatientAging | undefined,
  withAmounts: boolean,
): OverdueBalance {
  if (!aging) return { hasOverdue: false, overdueDays: null };
  const { hasOverdue, overdueDays, amounts } = overdueOf(aging);
  if (!hasOverdue) return { hasOverdue, overdueDays };
  return withAmounts
    ? { hasOverdue, overdueDays, amounts }
    : { hasOverdue, overdueDays };
}
