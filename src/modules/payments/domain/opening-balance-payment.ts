/*
 * Abono contra el saldo migrado de un paciente (DX-262, revisión C1): un
 * abono va a un plan O a un saldo migrado (CHECK payments_target_check), en la
 * moneda del saldo y sin pasarse de lo pendiente.
 */
import type { RegionalFormat } from '../../../shared/format/regional-format';

export const OPENING_BALANCE_NOT_FOUND_MESSAGE =
  'Saldo migrado no encontrado en esta clínica (o ya retirado).';

export function openingBalanceCurrencyMessage(currency: string): string {
  return `El abono al saldo migrado tiene que ir en su moneda (${currency}).`;
}

export const OPENING_BALANCE_PAID_MESSAGE =
  'Este saldo migrado ya está pagado: no admite más abonos.';

/**
 * El abono supera lo pendiente (`pending` > 0; con 0, `OPENING_BALANCE_PAID_MESSAGE`).
 * `fmt`: el formato de la sede donde se registra el abono (G1-B), pedido
 * solo para pintar este 400 (I4).
 */
export function openingBalanceOverpaidMessage(
  pending: number,
  currency: string,
  fmt: RegionalFormat,
): string {
  return `El abono supera lo pendiente del saldo migrado: quedan ${fmt.money(pending, currency)}.`;
}
