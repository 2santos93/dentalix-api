/**
 * Valor comparable: instantes por su ISO; objetos con las claves ordenadas
 * (un jsonb de Postgres no guarda el orden en que llegaron); vacío = null.
 */
function comparable(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) => {
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([x], [y]) =>
          x < y ? -1 : x > y ? 1 : 0,
        ),
      );
    }
    return v;
  });
}

/**
 * DX-095: de los `fields` que pidió una edición, los que de verdad cambiaron
 * entre lo guardado antes (`before`) y después (`after`). Es el
 * `changedFields` exacto del evento de auditoría: un campo que llega con el
 * mismo valor no figura. `null`, `undefined` y ausente valen lo mismo. Un
 * campo que no está en ninguno de los dos lados (la entidad no lo guarda
 * con ese nombre) se da por cambiado: no se puede comprobar y callarlo
 * escondería una escritura. Solo nombres, nunca valores; ordenados.
 */
export function changedFields(
  before: object,
  after: object,
  fields: Iterable<string>,
): string[] {
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const out = new Set<string>();
  for (const field of fields) {
    if (!(field in b) && !(field in a)) {
      out.add(field);
      continue;
    }
    if (comparable(b[field]) !== comparable(a[field])) out.add(field);
  }
  return [...out].sort();
}
