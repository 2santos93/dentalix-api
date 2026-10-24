/**
 * Clave de comparación de un nº de documento (DX-107): solo letras ASCII y
 * dígitos, en mayúsculas. «1.111.111», «1111111» y «1-111-111» son el mismo.
 *
 * DX-287: se descarta todo lo que no sea [0-9A-Za-z] ANTES de pasar a
 * mayúsculas, así que la clave no depende del mapeo Unicode («ß» → «SS» en
 * JS) ni de la locale de Postgres. La misma regla en SQL es
 * `public.dx_doc_key(text)`, que mantiene la columna indexada
 * `patients."docKey"` (trigger patients_doc_key): las consultas comparan esa
 * columna, nunca la expresión por fila (bajo RLS no usaría índice).
 */
export function docKey(docNumber: string): string {
  return docNumber.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}
