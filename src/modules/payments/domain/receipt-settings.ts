/**
 * DX-515: el recibo de caja NO es una factura fiscal. La clínica puede darle
 * un título propio y una leyenda (por clínica, o propia de una sede), y anotar
 * en cada abono el nº de la factura que emitió fuera de Dentalix. Todo es texto
 * libre y opcional, sin formato ni texto por defecto de ningún país: sin nada
 * configurado, el recibo sale igual que antes.
 */

/** Topes (los mismos CHECK en la BD, migración 20261112150000). */
export const RECEIPT_TITLE_MAX = 60;
/** Cabe entera en el antes y el después de la auditoría (tope 255). */
export const RECEIPT_LEGEND_MAX = 250;
export const EXTERNAL_INVOICE_NUMBER_MAX = 64;

export const RECEIPT_TITLE_MESSAGE = `El título del recibo admite hasta ${RECEIPT_TITLE_MAX} caracteres en una línea.`;
export const RECEIPT_LEGEND_MESSAGE = `La leyenda del recibo admite hasta ${RECEIPT_LEGEND_MAX} caracteres en una línea.`;
export const EXTERNAL_INVOICE_NUMBER_MESSAGE = `El nº de factura externa admite hasta ${EXTERNAL_INVOICE_NUMBER_MAX} caracteres en una línea.`;

/** Ajustes del recibo de la clínica: `null` = sin configurar. */
export interface ClinicReceiptSettings {
  title: string | null;
  legend: string | null;
}

/** La leyenda propia de una sede: `override` false = usa la de la clínica. */
export interface LocationReceiptLegend {
  override: boolean;
  /** Con `override`, la leyenda de la sede; `null` = la sede no imprime ninguna. */
  legend: string | null;
}

/** Lo que se congela en la foto del recibo al emitirlo. */
export interface ReceiptTexts {
  title: string | null;
  legend: string | null;
}

// Controles, separadores de línea y de párrafo: el texto va en UNA línea.
const NOT_ONE_LINE = /[\p{Cc}\u2028\u2029]/u;

/**
 * Un texto libre de los ajustes tal como se guarda: recortado, `null` si queda
 * vacío. `undefined` si no cabe (más del tope o con saltos de línea): el caso
 * de uso responde 400 con su mensaje.
 */
export function normalizeReceiptText(
  value: string | null | undefined,
  max: number,
): string | null | undefined {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (NOT_ONE_LINE.test(trimmed) || [...trimmed].length > max) {
    return undefined;
  }
  return trimmed;
}

/** La leyenda que imprime un recibo de esta sede, o `null` (ninguna). */
export function effectiveReceiptLegend(
  clinic: ClinicReceiptSettings,
  location: LocationReceiptLegend,
): string | null {
  return location.override ? location.legend : clinic.legend;
}
