import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// DX-287 (DB-047): la clave normalizada del documento ya no se calcula por
// fila en las consultas. Los pacientes tienen la columna indexada "docKey"
// (trigger patients_doc_key) y lo demás llama a public.dx_doc_key. Repetir
// regexp_replace(upper("docNumber")…) en una consulta vuelve a recorrer toda
// la clínica bajo RLS (no es LEAKPROOF) y, además, con otra regla que la del
// trigger.
const SRC = join(__dirname, '..', '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('DX-287: sin clave de documento calculada por fila en SQL', () => {
  it('ningún fichero de src compara regexp_replace(upper(...docNumber...))', () => {
    const offenders = sources(SRC)
      .filter((path) =>
        /regexp_replace\s*\(\s*upper\s*\([^)]*docNumber/i.test(
          readFileSync(path, 'utf8'),
        ),
      )
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });
});
