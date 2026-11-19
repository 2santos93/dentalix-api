import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-562: citas en serie. Cuatro migraciones aditivas: el valor de enum en su
// propio fichero, la tabla nueva con las columnas de appointments (NULL, sin
// DEFAULT) y sus restricciones NOT VALID, el índice CONCURRENTLY solo en su
// fichero y el VALIDATE con NO FORCE / FORCE (DX-134). Nada se borra,
// renombra ni recorre; lock_timeout antes de la primera sentencia.

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const ENUM = '20270116140000_dx562_email_template_enum';
const TABLES = '20270116140100_dx562_appointment_series';
const INDEX = '20270116140200_dx562_appointments_series_idx';
const VALIDATE = '20270116140300_dx562_validate';
const ALL = [ENUM, TABLES, INDEX, VALIDATE];

describe('DX-562: migraciones aditivas', () => {
  it.each([ENUM, TABLES, VALIDATE])(
    '%s fija lock_timeout antes de la primera sentencia',
    (m) => {
      expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    },
  );

  it('ninguna borra, renombra, recorre ni toca columnas existentes', () => {
    for (const m of ALL) {
      expect(code(m)).not.toMatch(
        /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|DISABLE\s+TRIGGER/im,
      );
    }
  });

  it('el valor de enum va solo en su fichero', () => {
    expect(
      code(ENUM)
        .replace(/^SET LOCAL lock_timeout = '5s';/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe(
      `ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'appointment-series';`,
    );
  });

  it('la serie: sin paciente ni profesional, solo se crea, FK directa a tenants, topes, RLS FORCE con NULLIF y sin UPDATE ni DELETE para la app', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    expect(sql).toContain('CREATE TABLE "appointment_series"');
    const table = /CREATE TABLE "appointment_series" \((.*?)\);/.exec(sql)![1];
    expect(table).not.toMatch(/patientId|providerId/);
    expect(table).toContain(
      'CONSTRAINT "appointment_series_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT',
    );
    expect(table).toContain('CHECK ("intervalWeeks" BETWEEN 1 AND 12)');
    expect(table).toContain('CHECK ("occurrences" BETWEEN 1 AND 26)');
    expect(table).not.toMatch(/cancelled/);
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "appointment_series_tenant_id_key" ON "appointment_series"("tenantId", "id");',
    );
    expect(sql).toContain(
      'ALTER TABLE "appointment_series" ENABLE ROW LEVEL SECURITY;',
    );
    expect(sql).toContain(
      'ALTER TABLE "appointment_series" FORCE ROW LEVEL SECURITY;',
    );
    expect(
      sql.match(
        /NULLIF\(current_setting\('app\.current_tenant', true\), ''\)::uuid/g,
      )!.length,
    ).toBe(2);
    expect(sql).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON "appointment_series" FROM dentalix_app;',
    );
    // No entra en la lista cerrada de la fusión (no tiene paciente).
    expect(sql).not.toContain('dx_patient_merge_tables');
  });

  it('appointments: dos columnas NULL sin DEFAULT, CHECK y FK compuesta NOT VALID', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    expect(sql).toContain(
      'ALTER TABLE "appointments" ADD COLUMN "seriesId" UUID, ADD COLUMN "seriesIndex" SMALLINT;',
    );
    expect(sql).toContain(
      'ALTER TABLE "appointments" ADD CONSTRAINT "appointments_series_check" CHECK ( ("seriesId" IS NULL) = ("seriesIndex" IS NULL) AND ("seriesIndex" IS NULL OR "seriesIndex" BETWEEN 1 AND 26) ) NOT VALID;',
    );
    expect(sql).toContain(
      'ALTER TABLE "appointments" ADD CONSTRAINT "appointments_series_fkey" FOREIGN KEY ("tenantId", "seriesId") REFERENCES "appointment_series"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;',
    );
    expect(sql).not.toMatch(/"appointments"[^;]*\bDEFAULT\b/);
  });

  it('el índice va CONCURRENTLY, único y parcial, solo en su fichero', () => {
    expect(code(INDEX)).toBe(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "appointments_tenant_series_index_key" ON "appointments" ("tenantId", "seriesId", "seriesIndex") WHERE "seriesId" IS NOT NULL;',
    );
  });

  it('el VALIDATE va aparte, con NO FORCE en las dos tablas y FORCE al final', () => {
    const lines = code(VALIDATE)
      .split(';')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    expect(lines).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ANALYZE "appointments" ("seriesId")',
      'ALTER TABLE "appointments" NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "appointment_series" NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "appointments" VALIDATE CONSTRAINT "appointments_series_fkey"',
      'ALTER TABLE "appointments" VALIDATE CONSTRAINT "appointments_series_check"',
      'ALTER TABLE "appointment_series" FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY',
    ]);
  });
});
