/*
 * Abono contra el saldo migrado de un paciente (DX-262, revisión C1): un
 * abono va a un plan O a un saldo migrado (CHECK payments_target_check), en la
 * moneda del saldo y sin pasarse de lo pendiente.
 */
import { formatMoney as money } from '../../../shared/money/format-money';

export const OPENING_BALANCE_NOT_FOUND_MESSAGE =
  'Saldo migrado no encontrado en esta clínica (o ya retirado).';

export function openingBalanceCurrencyMessage(currency: string): string {
  return `El abono al saldo migrado tiene que ir en su moneda (${currency}).`;
}

export function openingBalanceOverpaidMessage(
  pending: number,
  currency: string,
): string {
  return pending <= 0
    ? 'Este saldo migrado ya está pagado: no admite más abonos.'
    : `El abono supera lo pendiente del saldo migrado: quedan ${money(pending, currency)}.`;
}
