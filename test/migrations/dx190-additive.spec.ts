import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-190: ortodoncia. Cuatro migraciones aditivas: los valores de enum en su
// propio fichero, los índices parciales de audit_events con ON ONLY + ATTACH,
// las tablas nuevas (FK directa a tenants, FK compuestas, RLS FORCE con
// NULLIF, guardas con la puerta de la fusión) y el VALIDATE del CHECK de
// tenants en su propio fichero. Nada se borra, renombra ni recorre;
// lock_timeout antes de la primera sentencia.

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const ENUM = '20261229190000_dx190_audit_enum';
const INDEX = '20261229190100_dx190_audit_events_idx';
const TABLES = '20261229190200_dx190_orthodontics';
const VALIDATE = '20261229190300_dx190_validate';
const ALL = [ENUM, INDEX, TABLES, VALIDATE];

describe('DX-190: migraciones aditivas', () => {
  it.each(ALL)('%s fija lock_timeout antes de la primera sentencia', (m) => {
    expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
  });

  it('ninguna borra, renombra, recorre ni toca columnas existentes', () => {
    for (const m of ALL) {
      expect(code(m)).not.toMatch(
        /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|DISABLE\s+TRIGGER|NO\s+FORCE/im,
      );
    }
  });

  it('los valores de enum van solos en su fichero', () => {
    expect(
      code(ENUM)
        .replace(/^SET LOCAL lock_timeout = '5s';/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe(
      `ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'ORTHO_CASE'; ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'ORTHO_VISIT';`,
    );
  });

  it('cada índice parcial de audit_events va por partición, ON ONLY y ATTACH', () => {
    const sql = code(INDEX);
    for (const [low, up] of [
      ['ortho_case', 'ORTHO_CASE'],
      ['ortho_visit', 'ORTHO_VISIT'],
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `CREATE INDEX IF NOT EXISTS "audit_events_resource_${low}_idx"\\s+ON ONLY "audit_events" \\("tenantId", "occurredAt" DESC, "id" DESC\\)\\s+WHERE "resourceType" = '${up}';`,
        ),
      );
    }
    expect(sql.match(/ATTACH PARTITION/g)).toHaveLength(2);
    expect(sql).not.toMatch(/CONCURRENTLY/);
  });

  it('las tablas: FK directa a tenants con RESTRICT, RLS FORCE con NULLIF y un caso activo por paciente', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    for (const table of ['ortho_cases', 'ortho_visits']) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
      expect(sql).toContain(
        `CONSTRAINT "${table}_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT`,
      );
      expect(sql).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
      );
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
    }
    expect(
      sql.match(
        /NULLIF\(current_setting\('app\.current_tenant', true\), ''\)::uuid/g,
      )!.length,
    ).toBeGreaterThanOrEqual(4);
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "ortho_cases_one_active_key" ON "ortho_cases"("tenantId", "patientId") WHERE "status" = 'ACTIVE';`,
    );
    expect(sql).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON "ortho_visits" FROM dentalix_app;',
    );
    expect(sql).toContain(
      'REVOKE DELETE, TRUNCATE ON "ortho_cases" FROM dentalix_app;',
    );
  });

  it('las columnas nuevas de tenants llevan DEFAULT constante y el CHECK nace NOT VALID', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    expect(sql).toContain(
      'ADD COLUMN "orthodonticsEnabled" BOOLEAN NOT NULL DEFAULT false',
    );
    expect(sql).toMatch(
      /ADD COLUMN "orthoWireGauges" TEXT\[\] NOT NULL DEFAULT ARRAY\[/,
    );
    expect(sql).toMatch(
      /"tenants_ortho_wire_gauges_check" CHECK \(.*\) NOT VALID;/,
    );
    expect(code(VALIDATE).replace(/\s+/g, ' ')).toBe(
      `SET LOCAL lock_timeout = '5s'; ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_ortho_wire_gauges_check";`,
    );
  });

  it('las guardas abren la puerta de la fusión y la lista de la fusión incluye las dos tablas', () => {
    const sql = code(TABLES);
    expect(
      sql.match(/public\.dx_patient_merge_gate\(TG_TABLE_NAME/g),
    ).toHaveLength(2);
    expect(sql).toContain("'ortho_cases.patientId',");
    expect(sql).toContain("'ortho_visits.patientId',");
    expect(sql).toContain("'DX266_TWO_ACTIVE_ORTHO_CASES'");
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/g)!.length).toBe(4);
  });
});
