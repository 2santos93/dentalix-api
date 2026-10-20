import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import {
  findBareDeleteMany,
  formatBareDeleteMany,
  readMigrationSql,
  readSpecs,
  referencedTables,
  type SpecSource,
} from './bare-delete-many';

// DX-251 (TST-027): ningún e2e/int fuera de test/support/ limpia con
// `raw.<modelo>.deleteMany()` sin `where` sobre una tabla con hijos: entre
// ficheros se limpia con `resetDatabase(raw)` (TRUNCATE ... CASCADE).

const REPO_ROOT = join(__dirname, '..', '..');

const models = Prisma.dmmf.datamodel.models;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const tableOf = (name: string) =>
  models.find((m) => m.name === name)?.dbName ?? name;

/** Delegado de Prisma (`patient`) -> tabla (`patients`). */
const TABLE_OF_MODEL = new Map(
  models.map((m) => [lowerFirst(m.name), m.dbName ?? m.name]),
);

/** Tablas con hijos: por relaciones del schema y por FKs de las migraciones. */
const TABLES_WITH_CHILDREN = new Set<string>(
  readMigrationSql(REPO_ROOT).flatMap((sql) => [...referencedTables([sql])]),
);
for (const m of models) {
  for (const f of m.fields) {
    if (f.kind === 'object' && (f.relationFromFields?.length ?? 0) > 0) {
      TABLES_WITH_CHILDREN.add(tableOf(f.type));
    }
  }
}

const spec = (path: string, source: string): SpecSource => ({ path, source });
const find = (specs: SpecSource[]) =>
  findBareDeleteMany(specs, TABLE_OF_MODEL, TABLES_WITH_CHILDREN);

describe('DX-251: limpieza de e2e/int sin deleteMany() sin where sobre tablas con hijos', () => {
  it('patients y appointments tienen hijos (sanidad de la detección)', () => {
    expect(TABLE_OF_MODEL.get('patient')).toBe('patients');
    expect(TABLES_WITH_CHILDREN.has('patients')).toBe(true);
    expect(TABLES_WITH_CHILDREN.has('tenants')).toBe(true);
  });

  it('detecta raw.patient.deleteMany() en un e2e nuevo y propone resetDatabase', () => {
    const found = find([
      spec(
        'test/nuevo.e2e-spec.ts',
        `async function cleanup() {\n  await raw.perioExam.deleteMany({ where: { tenantId } });\n  await raw.patient.deleteMany();\n}`,
      ),
    ]);
    expect(found).toEqual([
      expect.objectContaining({
        path: 'test/nuevo.e2e-spec.ts',
        line: 3,
        model: 'patient',
        table: 'patients',
      }),
    ]);
    expect(formatBareDeleteMany(found)).toMatch(/resetDatabase\(raw\)/);
  });

  it('también en int-spec, con `{}` y en subcarpetas', () => {
    const found = find([
      spec('test/x.int-spec.ts', 'await raw.tenant.deleteMany({});'),
      spec('test/storage/y.e2e-spec.ts', 'await raw.user.deleteMany( );'),
    ]);
    expect(found.map((f) => f.table)).toEqual(['tenants', 'users']);
  });

  it('permite deleteMany con where, tablas hoja, test/support/ y unit', () => {
    expect(
      find([
        spec(
          'test/a.e2e-spec.ts',
          'await raw.patient.deleteMany({ where: { tenantId } });',
        ),
        spec('test/b.e2e-spec.ts', 'await raw.loginThrottle.deleteMany({});'),
        spec('test/support/e2e-fixtures.ts', 'await raw.patient.deleteMany();'),
        spec('src/x.spec.ts', 'await raw.patient.deleteMany();'),
      ]),
    ).toEqual([]);
  });

  it('ningún e2e/int del repo limpia así', () => {
    const found = find(readSpecs(REPO_ROOT));
    if (found.length > 0) {
      throw new Error(
        `${found.length} deleteMany() sin where sobre tablas con hijos:\n${formatBareDeleteMany(found)}`,
      );
    }
  });
});
