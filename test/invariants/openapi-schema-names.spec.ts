import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// DX-539-bis: Swagger nombra cada esquema del OpenAPI por el NOMBRE de la
// clase. Dos clases con @ApiProperty y el mismo nombre en módulos distintos se
// funden en UN esquema (gana una de las dos) y la web pierde campos sin que
// nada falle en la API: pasó con `UserRefDto` (DX-571 frente a data-consents,
// {id, name} contra {id, fullName}) y con dos DTOs de DX-172. Este invariante
// exige nombres únicos entre las clases que el OpenAPI publica.

const REPO_ROOT = join(__dirname, '..', '..');
const SRC = join(REPO_ROOT, 'src');

/**
 * Repetidos heredados y estructuralmente IGUALES (mismos campos y tipos), así
 * que fundirlos no cambia el contrato. Solo puede bajar: si dejan de estar
 * repetidos, salen de aquí; uno nuevo no entra (renómbralo).
 */
const IDENTICAL_DUPLICATES: ReadonlySet<string> = new Set([
  'CashLocationRefDto',
  'CashPatientRefDto',
]);

const CLASS = /^export\s+(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/gm;

function sources(dir: string): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sources(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      const source = readFileSync(full, 'utf8');
      if (source.includes('@ApiProperty')) {
        out.push({
          path: relative(REPO_ROOT, full).split(sep).join('/'),
          source,
        });
      }
    }
  }
  return out;
}

function schemaClasses(): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const { path, source } of sources(SRC)) {
    for (const m of source.matchAll(CLASS)) {
      const files = byName.get(m[1]) ?? [];
      files.push(path);
      byName.set(m[1], files);
    }
  }
  return byName;
}

describe('DX-539-bis: nombres únicos de los esquemas del OpenAPI', () => {
  const byName = schemaClasses();
  const repeated = [...byName].filter(([, files]) => files.length > 1);

  it('lee las clases de los DTO (el patrón no se ha quedado vacío)', () => {
    expect(byName.size).toBeGreaterThan(200);
  });

  it('ninguna clase con @ApiProperty repite nombre fuera de la lista heredada', () => {
    const fresh = repeated
      .filter(([name]) => !IDENTICAL_DUPLICATES.has(name))
      .map(([name, files]) => `${name}: ${files.join(', ')}`);
    expect(fresh).toEqual([]);
  });

  it('la lista heredada solo contiene nombres que siguen repetidos', () => {
    const stale = [...IDENTICAL_DUPLICATES].filter(
      (name) => (byName.get(name)?.length ?? 0) < 2,
    );
    expect(stale).toEqual([]);
  });
});
