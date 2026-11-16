import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-017: laboratorio dental. Tres migraciones aditivas: los valores de enum
// en su propio fichero, los índices parciales de audit_events con ON ONLY +
// ATTACH y las tablas nuevas (FK directa a tenants, FK compuestas, RLS FORCE
// con NULLIF, guardas con la puerta de la fusión, sin DELETE para la app).
// Nada se borra, renombra ni recorre; lock_timeout antes de la primera
// sentencia.

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const ENUM = '20261230170000_dx017_audit_enum';
const INDEX = '20261230170100_dx017_audit_events_idx';
const TABLES = '20261230170200_dx017_dental_lab_orders';
const ALL = [ENUM, INDEX, TABLES];
const NEW_TABLES = ['dental_labs', 'dental_lab_services', 'dental_lab_orders'];

describe('DX-017: migraciones aditivas', () => {
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
      `ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'DENTAL_LAB'; ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'DENTAL_LAB_ORDER';`,
    );
  });

  it('cada índice parcial de audit_events va por partición, ON ONLY y ATTACH', () => {
    const sql = code(INDEX);
    for (const [low, up] of [
      ['dental_lab', 'DENTAL_LAB'],
      ['dental_lab_order', 'DENTAL_LAB_ORDER'],
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

  it('las tablas: FK directa a tenants con RESTRICT, RLS FORCE con NULLIF y sin DELETE para la app', () => {
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
      expect(sql).toContain(
        `REVOKE DELETE, TRUNCATE ON "${table}" FROM dentalix_app;`,
      );
    }
    expect(
      sql.match(
        /NULLIF\(current_setting\('app\.current_tenant', true\), ''\)::uuid/g,
      )!.length,
    ).toBe(6);
  });

  it('FK compuestas por clínica: ítem y cita del MISMO paciente, servicio del MISMO laboratorio', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    expect(sql).toContain(
      'FOREIGN KEY ("tenantId", "patientId", "treatmentPlanItemId") REFERENCES "treatment_plan_items"("tenantId", "patientId", "id")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("tenantId", "patientId", "appointmentId") REFERENCES "appointments"("tenantId", "patientId", "id")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("tenantId", "labId", "serviceId") REFERENCES "dental_lab_services"("tenantId", "labId", "id")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("tenantId", "replacesOrderId") REFERENCES "dental_lab_orders"("tenantId", "id")',
    );
    expect(sql).toContain(
      `CREATE INDEX "dental_lab_orders_pending_idx" ON "dental_lab_orders"("tenantId", "locationId", "dueOn") WHERE "receivedAt" IS NULL AND "cancelledAt" IS NULL;`,
    );
  });

  it('la guarda abre la puerta de la fusión y la lista de la fusión incluye las órdenes', () => {
    const sql = code(TABLES);
    expect(
      sql.match(/public\.dx_patient_merge_gate\(TG_TABLE_NAME/g),
    ).toHaveLength(1);
    expect(sql).toContain("'dental_lab_orders.patientId',");
    expect(sql).toContain("'ortho_visits.patientId',");
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/g)!.length).toBe(5);
  });
});
