import { round2 } from '../../../../shared/money/money';
import {
  roundToDigits,
  type RoundingDigits,
} from '../../../../shared/money/line-rounding';
export type InstallmentStatus = 'PAID' | 'PARTIAL' | 'PENDING' | 'OVERDUE';

export interface ScheduleTramo {
  kind: 'DOWN_PAYMENT' | 'INSTALLMENT';
  sequence: number | null;
  dueDate: Date;
  amount: number;
}

export interface DerivedTramo extends ScheduleTramo {
  covered: number;
  status: InstallmentStatus;
}

/**
 * Greedy allocation of `paidTotal` across `tramos` IN ORDER (down payment
 * first, then installments 1..N). Status precedence per tramo:
 *   PAID     -> covered >= amount
 *   OVERDUE  -> not fully covered AND dueDate < today
 *   PARTIAL  -> future and 0 < covered < amount
 *   PENDING  -> future and covered == 0
 * `today` is passed in (never read from the clock) so callers/tests are
 * deterministic; compare on UTC calendar date to match GetPlanBalanceUseCase.
 *
 * DX-472: `paidIncomplete` = el proveedor de tasas no respondió y `paidTotal`
 * se queda corto por lo que no se pudo convertir. No se sabe qué tramos cubre
 * eso, así que ninguno sale OVERDUE (quedan PARTIAL o PENDING) hasta que el
 * saldo vuelva a estar completo.
 *
 * B4 (DX-472-bis): `roundingDigits` son los decimales de redondeo de la moneda
 * del plan de pagos (`currencies.rounding_digits`); sin ellos, 2.
 */
export function deriveStatuses(
  tramos: ScheduleTramo[],
  paidTotal: number,
  today: Date,
  {
    paidIncomplete = false,
    roundingDigits = 2,
  }: { paidIncomplete?: boolean; roundingDigits?: RoundingDigits } = {},
): DerivedTramo[] {
  const todayDay = today.toISOString().slice(0, 10);
  let remaining = round2(paidTotal);

  return tramos.map((tramo) => {
    let covered = round2(Math.min(Math.max(remaining, 0), tramo.amount));
    // B4 (DX-472-bis): un abono convertido a 2 decimales deja un residuo que
    // la moneda no tiene (¥14.999,87 de ¥15.000). Si lo que falta redondea a
    // 0 en los decimales de la moneda, el tramo está cubierto: se pintaría
    // como «0» y saldría vencido. Lo que falta de verdad (un céntimo de USD,
    // medio yen) sigue contando.
    if (
      covered < tramo.amount &&
      roundToDigits(round2(tramo.amount - covered), roundingDigits) === 0
    ) {
      covered = tramo.amount;
    }
    remaining = round2(remaining - covered);

    const isPastDue =
      !paidIncomplete && tramo.dueDate.toISOString().slice(0, 10) < todayDay;
    let status: InstallmentStatus;
    if (covered >= tramo.amount) {
      status = 'PAID';
    } else if (isPastDue) {
      status = 'OVERDUE';
    } else if (covered > 0) {
      status = 'PARTIAL';
    } else {
      status = 'PENDING';
    }
    return { ...tramo, covered, status };
  });
}
