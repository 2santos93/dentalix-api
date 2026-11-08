/*
 * Abono contra el saldo migrado de un paciente (DX-262, revisión C1): un
 * abono va a un plan O a un saldo migrado (CHECK payments_target_check), en la
 * moneda del saldo y sin pasarse de lo pendiente.
 */
import type { RegionalFormat } from '../../../shared/format/regional-format';
import { endSentence } from '../../../shared/format/end-sentence';
import { moneyWithCode } from '../../../shared/format/money-with-code';
import type { CurrencyTexts } from '../../../shared/format/currency-text';

export const OPENING_BALANCE_NOT_FOUND_MESSAGE =
  'Saldo migrado no encontrado en esta clínica (o ya retirado).';

export function openingBalanceCurrencyMessage(currency: string): string {
  return `El abono al saldo migrado tiene que ir en su moneda (${currency}).`;
}

export const OPENING_BALANCE_PAID_MESSAGE =
  'Este saldo migrado ya está pagado: no admite más abonos.';

/**
 * El abono supera lo pendiente (`pending` > 0; con 0, `OPENING_BALANCE_PAID_MESSAGE`).
 * `fmt`: el formato de la sede del saldo migrado (la de su lote, R12), pedido
 * solo para pintar este 400 (G1-B, I4). `texts`: el texto propio de cada
 * moneda de la clínica (DX-517-bis), como en la pantalla. Un texto o símbolo
 * que ya acaba en punto («Bs.», «ج.م.») no lo dobla.
 */
export function openingBalanceOverpaidMessage(
  pending: number,
  currency: string,
  fmt: RegionalFormat,
  texts: CurrencyTexts | null,
): string {
  return endSentence(
    `El abono supera lo pendiente del saldo migrado: quedan ${moneyWithCode(pending, currency, fmt, texts)}`,
  );
}
