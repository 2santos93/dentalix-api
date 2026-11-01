// DX-496 (TST-059): para comprobar que un dato clínico o personal (una dosis,
// una referencia, un nº de afiliado) NO sale en un evento de auditoría, un log
// o una respuesta, buscarlo como subcadena en `JSON.stringify(...)` falla al
// azar cuando el dato es corto: el JSON lleva UUID y horas con milisegundos
// (`58a0931b-e204-…`, `…57.204Z`). Los ids y las fechas no pueden llevar el
// dato; lo llevan los números, los textos y las claves. `leavesWith` revisa
// solo esos, con subcadena, así que sigue viendo `204` dentro de
// «Dosis: 204 mg» o de `{ doseMg: 204 }`.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Un id o un instante: texto que se genera al azar y no puede llevar datos. */
function isIdOrInstant(text: string): boolean {
  return UUID.test(text) || ISO_INSTANT.test(text);
}

function hasToJson(value: object): value is { toJSON: () => unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

/**
 * Rutas (`metadata.notes[0]`) de las hojas y claves de `value` que contienen
 * `needle`, sin mirar ids (UUID) ni fechas (`Date` o ISO). Vacío si el dato no
 * aparece. Los `toJSON` (Decimal de Prisma) se revisan por su texto.
 */
export function leavesWith(value: unknown, needle: string | number): string[] {
  const target = String(needle);
  const found: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;
    if (node instanceof Date) return;
    if (typeof node === 'string') {
      if (!isIdOrInstant(node) && node.includes(target)) found.push(path);
      return;
    }
    if (typeof node === 'number' || typeof node === 'bigint') {
      if (String(node).includes(target)) found.push(path);
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    if (hasToJson(node)) {
      visit(String(node.toJSON()), path);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (key.includes(target)) found.push(childPath);
      visit(child, childPath);
    }
  };
  visit(value, '');
  return found;
}
