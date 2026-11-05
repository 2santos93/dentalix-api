/**
 * DX-539: detector de objetos «vacíos» en un documento OpenAPI. `type: Object`
 * (o un `@ApiProperty` sin `type` sobre un `string | null`/`number | null`, que
 * reflect-metadata reduce a `Object`) se publica como `{ "type": "object" }`
 * sin propiedades, y `openapi-typescript` lo emite como `Record<string, never>`:
 * el cliente pierde el tipado real y lo parchea a mano (DX-537).
 *
 * Devuelve las rutas (`Schema.propiedad`, `[]` para items, `{}` para valores de
 * mapa) de cada esquema que no dice nada de su forma. Un mapa libre DOCUMENTADO
 * (`additionalProperties` con tipo) no cuenta; `additionalProperties: true` o
 * `{}` sí, salvo que esté en `FREE_MAP_EXCEPTIONS`.
 */

type Json = Record<string, unknown>;

/** Mapas libres de verdad, con el motivo. La clave es `Schema.propiedad`. */
export const FREE_MAP_EXCEPTIONS: Readonly<Record<string, string>> = {
  'FailedJobDto.payload':
    'Payload del job de BullMQ tal cual se encoló: su forma depende de cada cola y no tiene contrato único.',
};

const isObj = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isBare(s: Json): boolean {
  if ('$ref' in s || 'oneOf' in s || 'anyOf' in s || 'allOf' in s) return false;
  if (s.type === 'object') {
    return !s.properties && s.additionalProperties === undefined;
  }
  return (
    s.type === undefined &&
    !s.enum &&
    !s.properties &&
    !s.items &&
    !s.format &&
    !s.const
  );
}

function isUntypedMap(s: Json): boolean {
  const ap = s.additionalProperties;
  return ap === true || (isObj(ap) && Object.keys(ap).length === 0);
}

function walk(s: unknown, path: string, out: string[]): void {
  if (!isObj(s)) return;
  if (isBare(s)) out.push(path);
  else if (isUntypedMap(s) && !(path in FREE_MAP_EXCEPTIONS)) out.push(path);
  if (isObj(s.properties)) {
    for (const [k, v] of Object.entries(s.properties)) {
      walk(v, `${path}.${k}`, out);
    }
  }
  if (s.items) walk(s.items, `${path}[]`, out);
  if (isObj(s.additionalProperties)) {
    walk(s.additionalProperties, `${path}{}`, out);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const list = s[key];
    if (Array.isArray(list)) {
      list.forEach((x, i) => walk(x, `${path}/${key}${i}`, out));
    }
  }
}

export function findBareObjects(doc: unknown): string[] {
  const out: string[] = [];
  if (!isObj(doc) || !isObj(doc.components)) return out;
  const schemas = doc.components.schemas;
  if (isObj(schemas)) {
    for (const [name, schema] of Object.entries(schemas)) {
      if (!isObj(schema) || !isObj(schema.properties)) continue;
      for (const [k, v] of Object.entries(schema.properties)) {
        walk(v, `${name}.${k}`, out);
      }
    }
  }
  return out;
}
