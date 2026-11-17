import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-018: honorarios de odontólogos. Tres migraciones aditivas: el valor de
// enum en su propio fichero, el índice parcial de audit_events con ON ONLY +
// ATTACH y las tablas nuevas (FK directa a tenants, FK compuestas, RLS FORCE
// con NULLIF, liquidación append-only y sin solapes). Nada se borra,
// renombra ni recorre; lock_timeout antes de la primera sentencia.

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const ENUM = '20270101090000_dx018_audit_enum';
const INDEX = '20270101090100_dx018_audit_events_idx';
const TABLES = '20270101090200_dx018_commissions';
const ALL = [ENUM, INDEX, TABLES];
const NEW_TABLES = [
  'commission_rules',
  'commission_rule_categories',
  'commission_settlements',
  'commission_settlement_lines',
];

describe('DX-018: migraciones aditivas', () => {
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

  it('el valor de enum va solo en su fichero', () => {
    expect(
      code(ENUM)
        .replace(/^SET LOCAL lock_timeout = '5s';/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe(
      `ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'COMMISSION_SETTLEMENT';`,
    );
  });

  it('el índice parcial de audit_events va por partición, ON ONLY y ATTACH', () => {
    const sql = code(INDEX);
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "audit_events_resource_commission_settlement_idx"\s+ON ONLY "audit_events" \("tenantId", "occurredAt" DESC, "id" DESC\)\s+WHERE "resourceType" = 'COMMISSION_SETTLEMENT';/,
    );
    expect(sql.match(/ATTACH PARTITION/g)).toHaveLength(1);
    expect(sql).not.toMatch(/CONCURRENTLY/);
  });

  it('las tablas: FK directa a tenants con RESTRICT y RLS FORCE con NULLIF', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    for (const table of NEW_TABLES) {
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
    ).toBe(8);
  });

  it('la liquidación y sus líneas son append-only; la regla no se borra', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    for (const table of [
      'commission_settlements',
      'commission_settlement_lines',
    ]) {
      expect(sql).toContain(
        `REVOKE UPDATE, DELETE, TRUNCATE ON "${table}" FROM dentalix_app;`,
      );
      expect(sql).toContain(
        `BEFORE INSERT OR UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION public.dx_commission_settlement_guard();`,
      );
    }
    expect(sql).toContain(
      'REVOKE DELETE, TRUNCATE ON "commission_rules" FROM dentalix_app;',
    );
  });

  it('FK compuestas por clínica, sin solapes por profesional y un devengo por profesional', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    expect(sql).toContain(
      'FOREIGN KEY ("tenantId", "membershipId", "userId") REFERENCES "clinic_memberships"("tenantId", "id", "userId")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("tenantId", "treatmentPlanItemId", "treatmentPlanId") REFERENCES "treatment_plan_items"("tenantId", "id", "planId")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("tenantId", "paymentId", "treatmentPlanId") REFERENCES "payments"("tenantId", "id", "treatmentPlanId")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("tenantId", "settlementId", "userId") REFERENCES "commission_settlements"("tenantId", "id", "userId")',
    );
    expect(sql).toContain(
      `EXCLUDE USING gist ( "tenantId" WITH =, "membershipId" WITH =, daterange("periodFrom", "periodTo", '[]') WITH && )`,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "commission_settlement_lines_accrual_key"[^;]+WHERE "kind" = 'ACCRUAL';/,
    );
    // Sin columnas hacia patients: la fusión de pacientes no cambia.
    expect(sql).not.toMatch(/"patientId"|dx_patient_merge/);
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/g)!.length).toBe(2);
  });
});
