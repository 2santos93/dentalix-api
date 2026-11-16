import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-559: plantillas de plan de tratamiento. Tres migraciones aditivas: el
// valor de enum en su propio fichero, el índice parcial de audit_events con
// ON ONLY + ATTACH y las dos tablas nuevas (con FK directa a tenants, FK
// compuestas, CHECK y RLS FORCE con NULLIF). Nada se borra, renombra ni
// recorre sobre tablas existentes; lock_timeout antes de la primera sentencia.

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const ENUM = '20261228090000_dx559_audit_enum';
const INDEX = '20261228090100_dx559_audit_events_idx';
const TABLES = '20261228090200_dx559_treatment_plan_templates';

describe('DX-559: migraciones aditivas', () => {
  it.each([ENUM, INDEX, TABLES])(
    '%s fija lock_timeout antes de la primera sentencia',
    (m) => {
      expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    },
  );

  it('ninguna borra, renombra, recorre ni toca columnas existentes', () => {
    for (const m of [ENUM, INDEX, TABLES]) {
      expect(code(m)).not.toMatch(
        /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|DISABLE\s+TRIGGER|NO\s+FORCE/im,
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
      `ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'TREATMENT_PLAN_TEMPLATE';`,
    );
  });

  it('el índice parcial de audit_events va por partición, ON ONLY y ATTACH', () => {
    const sql = code(INDEX);
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "audit_events_resource_treatment_plan_template_idx"\s+ON ONLY "audit_events" \("tenantId", "occurredAt" DESC, "id" DESC\)\s+WHERE "resourceType" = 'TREATMENT_PLAN_TEMPLATE';/,
    );
    expect(sql).toContain('ATTACH PARTITION');
    expect(sql).not.toMatch(/CONCURRENTLY/);
  });

  it('las tablas: FK directa a tenants, FK compuestas, RLS FORCE con NULLIF y sin DELETE en la cabecera', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    for (const table of [
      'treatment_plan_templates',
      'treatment_plan_template_lines',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
      expect(sql).toContain(
        `CONSTRAINT "${table}_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT`,
      );
      expect(sql).toContain(
        `CREATE UNIQUE INDEX "${table}_tenant_id_key" ON "${table}"("tenantId", "id");`,
      );
      expect(sql).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
      );
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
    }
    expect(
      sql.match(
        /NULLIF\(current_setting\('app\.current_tenant', true\), ''\)::uuid/g,
      ),
    ).toHaveLength(4);
    expect(sql).toContain(
      'FOREIGN KEY ("tenantId", "templateId") REFERENCES "treatment_plan_templates"("tenantId", "id") ON DELETE CASCADE',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("tenantId", "catalogItemId") REFERENCES "dental_catalog_items"("tenantId", "id") ON DELETE RESTRICT',
    );
    expect(sql).toContain(
      'REVOKE DELETE, TRUNCATE ON "treatment_plan_templates" FROM dentalix_app;',
    );
    expect(sql).not.toMatch(/REVOKE[^;]*"treatment_plan_template_lines"/);
  });

  it('los CHECK de nombre, cantidad, visita, posición, etiqueta e intervalos', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    for (const check of [
      'CHECK (char_length(btrim("name")) BETWEEN 1 AND 80)',
      'CHECK ("position" BETWEEN 0 AND 49)',
      'CHECK ("quantity" BETWEEN 1 AND 20)',
      'CHECK ("visit" BETWEEN 1 AND 50)',
      'CHECK ("visitLabel" IS NULL OR char_length(btrim("visitLabel")) BETWEEN 1 AND 60)',
      'CHECK (public.dx559_valid_template_intervals("visitIntervals"))',
    ]) {
      expect(sql).toContain(check);
    }
  });
});
