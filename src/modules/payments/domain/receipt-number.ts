/** Serie de recibos de una sede (DX-136): la misma regla que el CHECK de `locations`. */
export const RECEIPT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,5}$/;

const NUMBER_DIGITS = 6;

/**
 * Número visible del recibo: la serie de la sede, un guion y el consecutivo
 * con al menos 6 cifras (`BOG-000123`). Pasado el millón crece, nunca se
 * recorta ni vuelve a empezar.
 */
export function formatReceiptNumber(prefix: string, number: number): string {
  if (!RECEIPT_PREFIX_PATTERN.test(prefix)) {
    throw new RangeError(`Serie de recibo inválida: ${prefix}`);
  }
  if (!Number.isInteger(number) || number <= 0) {
    throw new RangeError(`Número de recibo inválido: ${number}`);
  }
  return `${prefix}-${String(number).padStart(NUMBER_DIGITS, '0')}`;
}

/**
 * Referencia de un abono anterior a la numeración consecutiva (DX-136): la
 * que imprimía la web hasta entonces (`REC-` y los 8 primeros caracteres del
 * id). Esos abonos no se renumeran: conservan esta referencia «sin serie».
 */
export function legacyReceiptReference(paymentId: string): string {
  return `REC-${paymentId.slice(0, 8)}`;
}
