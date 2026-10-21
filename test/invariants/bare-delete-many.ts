import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// DX-251 (TST-027): un `raw.<modelo>.deleteMany()` sin `where` en un e2e/int
// borra TODAS las filas de esa tabla, también las que dejó otro fichero. Si la
// tabla tiene hijos (FK hacia ella) y otro spec dejó filas hijas (p. ej. citas
// de patient-flow), la limpieza choca con la FK y tumba el fichero entero
// según el orden de ejecución. La limpieza entre ficheros es
// `resetDatabase(raw)` (test/support/e2e-fixtures.ts: TRUNCATE ... CASCADE).

export interface SpecSource {
  /** Ruta relativa a la raíz del repo, con `/`. */
  path: string;
  source: string;
}

export interface BareDeleteMany {
  path: string;
  line: number;
  call: string;
  model: string;
  table: string;
}

/** `x.modelo.deleteMany()` o `x.modelo.deleteMany({})`: sin filtro. */
const BARE_DELETE_MANY =
  /\b([A-Za-z_$][\w$]*)\.([a-z][\w$]*)\.deleteMany\(\s*(?:\{\s*\}\s*)?\)/g;

/** Solo specs que tocan la BD real; `test/support/` es quien limpia. */
export function isCheckedSpec(path: string): boolean {
  return (
    /\.(e2e|int)-spec\.ts$/.test(path) && !path.split('/').includes('support')
  );
}

/**
 * Busca deleteMany sin filtro sobre modelos cuya tabla tiene hijos.
 * `tablesWithChildren`: nombres de TABLA referenciados por alguna FK.
 * `tableOfModel`: delegado de Prisma (`patient`) -> tabla (`patients`).
 */
export function findBareDeleteMany(
  specs: SpecSource[],
  tableOfModel: ReadonlyMap<string, string>,
  tablesWithChildren: ReadonlySet<string>,
): BareDeleteMany[] {
  const found: BareDeleteMany[] = [];
  for (const spec of specs) {
    if (!isCheckedSpec(spec.path)) continue;
    for (const m of spec.source.matchAll(BARE_DELETE_MANY)) {
      const model = m[2];
      const table = tableOfModel.get(model);
      // Delegado desconocido (no es Prisma): se ignora. Tabla hoja: no hay
      // FK con la que chocar.
      if (!table || !tablesWithChildren.has(table)) continue;
      const line = spec.source.slice(0, m.index).split('\n').length;
      found.push({ path: spec.path, line, call: m[0], model, table });
    }
  }
  return found;
}

export function formatBareDeleteMany(found: BareDeleteMany[]): string {
  return found
    .map(
      (f) =>
        `${f.path}:${f.line}: \`${f.call}\` borra sin \`where\` la tabla "${f.table}", que tiene hijos: ` +
        `choca con la FK si otro spec dejó filas hijas. Usa \`await resetDatabase(raw)\` ` +
        `(test/support/e2e-fixtures.ts, TRUNCATE ... CASCADE) o filtra con \`where\`.`,
    )
    .join('\n');
}

/** Tablas referenciadas por un `REFERENCES "tabla"` en las migraciones. */
export function referencedTables(migrationSql: string[]): Set<string> {
  const tables = new Set<string>();
  for (const sql of migrationSql) {
    for (const m of sql.matchAll(/REFERENCES\s+(?:"public"\.)?"([^"]+)"/gi)) {
      tables.add(m[1]);
    }
  }
  return tables;
}

/** Lee recursivamente los specs e2e/int del repo (fuera de test/support). */
export function readSpecs(
  repoRoot: string,
  dir = join(repoRoot, 'test'),
): SpecSource[] {
  const out: SpecSource[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...readSpecs(repoRoot, full));
      continue;
    }
    const path = relative(repoRoot, full).split(sep).join('/');
    if (isCheckedSpec(path)) {
      out.push({ path, source: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

/** SQL de todas las migraciones (`prisma/migrations/<nombre>/migration.sql`). */
export function readMigrationSql(repoRoot: string): string[] {
  const dir = join(repoRoot, 'prisma', 'migrations');
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readFileSync(join(dir, e.name, 'migration.sql'), 'utf8'));
}
