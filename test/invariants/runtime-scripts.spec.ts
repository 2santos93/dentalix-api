import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  citiesFromPackage,
  loadCitySeedRows,
  type CitySeedRow,
} from '../../prisma/reference/cities';

// DX-083 (OPS-021): el seed de referencia y `audit:purge` corren en la imagen
// de runtime (`npm ci --omit=dev`) compilados a dist/scripts, sin ts-node ni
// country-state-city.

const ROOT = join(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};
const tsconfig = JSON.parse(
  readFileSync(join(ROOT, 'tsconfig.scripts.json'), 'utf8'),
) as { include: string[] };

/**
 * Módulos que un fichero carga de forma estática (`import ... from 'x'`); los
 * `import type` se borran al compilar y no cuentan.
 */
function staticImports(file: string): string[] {
  const source = readFileSync(join(ROOT, file), 'utf8');
  return [...source.matchAll(/^import (?!type )[^;]*?from '([^']+)';/gms)].map(
    (m) => m[1],
  );
}

describe('scripts de la imagen de runtime (DX-083)', () => {
  it('country-state-city y ts-node son solo de desarrollo', () => {
    expect(pkg.devDependencies['country-state-city']).toBeDefined();
    expect(pkg.dependencies['country-state-city']).toBeUndefined();
    expect(pkg.dependencies['ts-node']).toBeUndefined();
  });

  it('el seed y la purga compilados se ejecutan con node, no con ts-node', () => {
    expect(tsconfig.include).toEqual(
      expect.arrayContaining([
        'prisma/seed.ts',
        'prisma/audit-purge.ts',
        'prisma/retention-raise-floor.ts',
      ]),
    );
    expect(pkg.scripts['seed:prod']).toBe('node dist/scripts/prisma/seed.js');
    expect(pkg.scripts['audit:purge:prod']).toBe(
      'node dist/scripts/prisma/audit-purge.js',
    );
    expect(pkg.scripts['retention:raise-floor:prod']).toBe(
      'node dist/scripts/prisma/retention-raise-floor.js',
    );
  });

  it('el seed y la purga no importan devDependencies de forma estática', () => {
    const dev = Object.keys(pkg.devDependencies);
    for (const file of [
      'prisma/seed.ts',
      'prisma/audit-purge.ts',
      'prisma/retention-raise-floor.ts',
      'prisma/reference/cities.ts',
    ]) {
      const bad = staticImports(file).filter((m) =>
        dev.some((d) => m === d || m.startsWith(`${d}/`)),
      );
      expect({ file, bad }).toEqual({ file, bad: [] });
    }
  });

  describe('ciudades', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'dx083-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('si hay cities.json (imagen) se leen de ahí, sin tocar el paquete', () => {
      const rows: CitySeedRow[] = [
        { countryCode: 'CO', name: 'Bogotá', region: 'Bogotá D.C.' },
      ];
      const file = join(dir, 'cities.json');
      writeFileSync(file, JSON.stringify(rows));
      expect(loadCitySeedRows(file)).toEqual(rows);
    });

    it('sin JSON (desarrollo) salen del paquete, agrupadas por país', () => {
      const rows = loadCitySeedRows(join(dir, 'no-existe.json'));
      expect(rows.length).toBeGreaterThan(100_000);
      expect(rows).toEqual(citiesFromPackage());
      expect(rows.some((r) => r.countryCode === 'CO')).toBe(true);
    });
  });
});
