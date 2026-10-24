import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-287 (DB-047, sin repetir DB-048): la clave de documento de `patients`
// llega sin bloquear la tabla. Esquema (columna sin DEFAULT + trigger) con
// lock_timeout; relleno en una migración propia de UNA sentencia DO con COMMIT
// por lote, sin NO FORCE ni DDL; índice CONCURRENTLY solo en su fichero; y
// estadísticas de la columna con ANALYZE (ShareUpdateExclusive, no bloquea).

const dir = join(__dirname, '..', '..', 'prisma', 'migrations');
const read = (name: string) =>
  readFileSync(join(dir, name, 'migration.sql'), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
/** Sentencias de nivel superior (sin partir los cuerpos $$ … $$). */
const statements = (sql: string) =>
  sql
    .replace(/\$\$[\s\S]*?\$\$/g, () => '$$body$$')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');

const SCHEMA = '20261024100000_dx287_patients_doc_key';
const BACKFILL = '20261024100100_dx287_patients_doc_key_backfill';
const INDEX = '20261024100200_dx287_patients_doc_key_idx';
const ANALYZE = '20261024100300_dx287_patients_doc_key_analyze';

describe('DX-287: migraciones de patients."docKey" sin bloqueo largo', () => {
  it('el esquema empieza con lock_timeout y añade la columna sin DEFAULT ni GENERATED (no reescribe la tabla)', () => {
    const sql = read(SCHEMA);
    const stmts = statements(sql);
    expect(stmts[0]).toMatch(/^SET LOCAL lock_timeout = '\d+s'$/i);
    const onPatients = stmts.filter((s) => /^ALTER TABLE "patients"/i.test(s));
    expect(onPatients).toEqual([
      'ALTER TABLE "patients" ADD COLUMN "docKey" TEXT',
    ]);
    expect(sql).not.toMatch(
      /GENERATED|DEFAULT|NO FORCE|CREATE (UNIQUE )?INDEX|UPDATE "patients"/i,
    );
    expect(sql).toMatch(
      /CREATE TRIGGER "patients_doc_key" BEFORE INSERT OR UPDATE OF "docNumber", "docKey" ON "patients"/i,
    );
    expect(sql).toMatch(/SET search_path = pg_catalog, pg_temp/i);
  });

  it('el relleno es UNA sentencia DO, con COMMIT por lote, clínica fijada, lock_timeout e idempotente; sin NO FORCE ni DDL', () => {
    const sql = read(BACKFILL);
    const stmts = statements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatch(/^DO \$\$body\$\$$/);
    expect(sql).toMatch(/COMMIT;/);
    expect(sql).toMatch(/set_config\('app\.current_tenant', t::text, true\)/);
    expect(sql).toMatch(/set_config\('lock_timeout', '\d+s', true\)/);
    expect(sql).toMatch(/"docKey" IS NULL/);
    expect(sql).toMatch(/LIMIT \d+/);
    expect(sql).not.toMatch(
      /FORCE ROW LEVEL SECURITY|ALTER TABLE|CREATE |DROP /i,
    );
  });

  it('el índice va CONCURRENTLY, solo, en su propio fichero y con el predicado de las consultas', () => {
    const stmts = statements(read(INDEX));
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "patients_tenant_doc_key_live_idx" ON "patients" ("tenantId", "docKey") WHERE "deletedAt" IS NULL AND "docNumber" IS NOT NULL',
    );
  });

  it('las estadísticas de la columna, con lock_timeout y sin más DDL', () => {
    expect(statements(read(ANALYZE))).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ANALYZE "patients" ("docKey")',
    ]);
  });

  it('orden: esquema → relleno → índice → estadísticas', () => {
    expect([SCHEMA, BACKFILL, INDEX, ANALYZE]).toEqual(
      [SCHEMA, BACKFILL, INDEX, ANALYZE].sort(),
    );
  });
});
