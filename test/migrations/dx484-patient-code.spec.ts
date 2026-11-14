import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-484: el código del paciente entra en `patients` (tabla grande y caliente)
// sin bloquearla mientras se recorre (DX-225/DB-029, README «Rellenos
// grandes…»): columna con DEFAULT constante y triggers (solo catálogo), relleno
// en una única sentencia DO con COMMIT por lote, índice único CONCURRENTLY
// solo en su fichero, CHECK NOT VALID y su VALIDATE aparte. Ninguna usa
// NO FORCE.

const dir = join(__dirname, '..', '..', 'prisma', 'migrations');
const read = (name: string): string =>
  readFileSync(join(dir, name, 'migration.sql'), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const SCHEMA = '20261211090000_dx484_patient_code';
const BACKFILL = '20261211090100_dx484_patient_code_backfill';
const INDEX = '20261211090200_dx484_patient_code_idx';
const CHECK = '20261211090300_dx484_patient_code_check';
const VALIDATE = '20261211090400_dx484_patient_code_validate';

/** Sentencias de nivel superior (fuera de los cuerpos $$…$$). */
const statements = (sql: string): string[] =>
  sql
    .replace(/\$\$[\s\S]*?\$\$/g, '$$$$')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');

describe('DX-484: migraciones del código del paciente sin bloqueo largo', () => {
  it('van en orden: esquema, relleno, índice, CHECK NOT VALID y validación', () => {
    const order = [SCHEMA, BACKFILL, INDEX, CHECK, VALIDATE];
    expect([...order].sort()).toEqual(order);
  });

  it('ninguna quita FORCE de la RLS', () => {
    for (const name of [SCHEMA, BACKFILL, INDEX, CHECK, VALIDATE]) {
      expect(read(name)).not.toMatch(/NO FORCE ROW LEVEL SECURITY/i);
    }
  });

  it('el esquema fija lock_timeout primero y en patients solo añade la columna nullable con DEFAULT constante y los triggers', () => {
    const sql = read(SCHEMA);
    expect(sql).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    const onPatients = statements(sql).filter((s) =>
      /(ALTER TABLE|ON) "patients"/i.test(s),
    );
    expect(onPatients).toEqual([
      'ALTER TABLE "patients" ADD COLUMN "patientCode" INTEGER DEFAULT 0',
      'CREATE TRIGGER "patients_code_assign" BEFORE INSERT ON "patients" FOR EACH ROW EXECUTE FUNCTION public."dx_patients_code_assign"()',
      'CREATE TRIGGER "patients_code_immutable" BEFORE UPDATE OF "patientCode" ON "patients" FOR EACH ROW EXECUTE FUNCTION public."dx_patients_code_immutable"()',
    ]);
  });

  it('el contador nace con RLS FORCE, NULLIF y sin DELETE ni UPDATE de tabla para la app', () => {
    const sql = read(SCHEMA);
    expect(sql).toContain(
      'ALTER TABLE "patient_code_counters" ENABLE ROW LEVEL SECURITY',
    );
    expect(sql).toContain(
      'ALTER TABLE "patient_code_counters" FORCE ROW LEVEL SECURITY',
    );
    expect(sql).toContain(
      `USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)`,
    );
    expect(sql).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON "patient_code_counters" FROM dentalix_app',
    );
    expect(sql).toContain(
      'GRANT UPDATE ("lastNumber") ON "patient_code_counters" TO dentalix_app',
    );
  });

  it('el relleno es UNA sentencia DO con COMMIT por lote y la clínica fijada', () => {
    const sql = read(BACKFILL);
    expect(statements(sql)).toEqual(['DO $$']);
    expect(sql).toMatch(/set_config\('app\.current_tenant', t::text, true\)/);
    expect(sql).toMatch(/COMMIT;/);
    // Idempotente: solo los pendientes.
    expect(sql).toMatch(/AND p\."patientCode" = 0;/);
  });

  it('el índice único va CONCURRENTLY, solo, en su propia migración', () => {
    const sql = read(INDEX);
    expect(statements(sql)).toEqual([
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "patients_tenant_patient_code_key" ON "patients" ("tenantId", "patientCode")',
    ]);
  });

  it('el CHECK entra NOT VALID y se valida aparte, antes del SET NOT NULL', () => {
    expect(statements(read(CHECK))).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ALTER TABLE "patients" ADD CONSTRAINT "patients_patient_code_check" CHECK ("patientCode" IS NOT NULL AND "patientCode" > 0) NOT VALID',
    ]);
    const sql = read(VALIDATE);
    const order = [
      /^SET LOCAL lock_timeout = '5s';/,
      /ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_patient_code_check"/,
      /ALTER TABLE "patients" ALTER COLUMN "patientCode" SET NOT NULL/,
      /CREATE OR REPLACE FUNCTION public\."dx_patients_code_immutable"\(\)/,
    ].map((re) => sql.search(re));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });
});
