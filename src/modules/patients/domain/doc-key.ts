/**
 * Clave de comparación de un nº de documento (DX-107): mayúsculas, solo
 * letras y dígitos. «1.111.111», «1111111» y «1-111-111» son el mismo.
 * La misma regla en SQL: regexp_replace(upper("docNumber"), '[^0-9A-Z]', '', 'g').
 */
export function docKey(docNumber: string): string {
  return docNumber.toUpperCase().replace(/[^0-9A-Z]/g, '');
}
