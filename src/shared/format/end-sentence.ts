/**
 * Cierra una frase sin doblar el punto (G1-B): un texto formateado puede
 * acabar ya en «.», como la hora en 12 h («3:05 p. m.»), un día y mes
 * («21.10.») o el símbolo de algunas monedas («ج.م.»).
 */
export function endSentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}
