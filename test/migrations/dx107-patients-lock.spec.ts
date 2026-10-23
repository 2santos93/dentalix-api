import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-107, revisión 2026-10-23 (I3): las migraciones de la importación no
// bloquean `patients` (lecturas y escrituras) mientras la recorren. Una
// migración es UNA transacción: un NO FORCE (ACCESS EXCLUSIVE hasta el
// COMMIT) seguido de un VALIDATE o un CREATE INDEX sin CONCURRENTLY deja la
// agenda, la búsqueda y la ficha paradas durante el recorrido entero de la
// tabla (README, «Rellenos grandes…», DX-225/DB-029).

const dir = join(__dirname, '..', '..', 'prisma', 'migrations');
const read = (name: string) =>
  readFileSync(join(dir, name, 'migration.sql'), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

describe('DX-107: migraciones sin bloqueo largo de patients (I3)', () => {
  it('la del lote solo AÑADE la columna y la FK NOT VALID sobre patients', () => {
    const sql = read('20261022130100_dx107_patient_import_batches');
    const onPatients = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => /^(ALTER TABLE|CREATE (UNIQUE )?INDEX)\b/i.test(s))
      .filter((s) => /(TABLE|ON) "patients"/i.test(s));
    expect(onPatients).toHaveLength(2);
    expect(onPatients[0]).toMatch(
      /^ALTER TABLE "patients" ADD COLUMN "import_batch_id" UUID$/i,
    );
    expect(onPatients[1]).toMatch(
      /^ALTER TABLE "patients" ADD CONSTRAINT "patients_import_batch_fkey" FOREIGN KEY .* NOT VALID$/i,
    );
  });

  it('el índice de patients va CONCURRENTLY, solo, en su propia migración', () => {
    const sql = read('20261022130300_dx107_patients_import_batch_idx');
    const statements = sql.split(';').filter((s) => s.trim() !== '');
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(
      /^CREATE INDEX CONCURRENTLY IF NOT EXISTS "patients_tenant_import_batch_idx" ON "patients"/i,
    );
  });

  it('el VALIDATE va después del índice, con ANALYZE antes del NO FORCE y FORCE al final', () => {
    const sql = read('20261022130400_dx107_patients_import_batch_fk_validate');
    const order = [
      /SET LOCAL lock_timeout/i,
      /ANALYZE "patients" \("import_batch_id"\)/i,
      /ALTER TABLE "patients" NO FORCE ROW LEVEL SECURITY/i,
      /ALTER TABLE "patient_import_batches" NO FORCE ROW LEVEL SECURITY/i,
      /ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_import_batch_fkey"/i,
      /ALTER TABLE "patient_import_batches" FORCE ROW LEVEL SECURITY/i,
      /ALTER TABLE "patients" FORCE ROW LEVEL SECURITY/i,
    ].map((re) => sql.search(re));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(
      '20261022130300_dx107_patients_import_batch_idx' <
        '20261022130400_dx107_patients_import_batch_fk_validate',
    ).toBe(true);
  });
});
