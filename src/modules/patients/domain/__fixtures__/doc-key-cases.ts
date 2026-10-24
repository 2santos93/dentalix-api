/**
 * Casos de la clave de documento (DX-107, DX-287): [nº escrito, clave]. Los
 * comparten el unit de `docKey()` y el int-spec que exige la MISMA clave a
 * `public.dx_doc_key` y a la columna `patients."docKey"` (trigger).
 */
export const DOC_KEY_CASES: readonly (readonly [string, string])[] = [
  ['1111111', '1111111'],
  // Puntos, guiones, espacios y blancos alrededor.
  ['1.111.111', '1111111'],
  ['1-111-111', '1111111'],
  ['1 111 111', '1111111'],
  [' 52.987.654 ', '52987654'],
  ['\t1.020.304\n', '1020304'],
  // Minúsculas y letras (pasaporte, NUIP, CE).
  ['ab-12 345', 'AB12345'],
  ['nuip-77', 'NUIP77'],
  ['Ce/9876', 'CE9876'],
  // Vacío o sin letras ni dígitos: clave vacía (nunca coincide con nada).
  ['', ''],
  ['   ', ''],
  ['.-/', ''],
  // Fuera de ASCII: se descarta ANTES de pasar a mayúsculas, así que la
  // clave no depende del mapeo Unicode de JS ni de la locale de Postgres
  // («ß» sería «SS» en JS; «ı» o «ſ», «I» y «S» con glibc).
  ['ñ123', '123'],
  ['é-45', '45'],
  ['straße 9', 'STRAE9'],
  ['ﬁ12', '12'],
  ['ı7', '7'],
  ['ſ8', '8'],
  ['１２３', ''],
];
