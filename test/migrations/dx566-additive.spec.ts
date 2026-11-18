import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-566: control postoperatorio. Tres migraciones aditivas: el valor de enum
// en su propio fichero, el índice parcial de audit_events con ON ONLY +
// ATTACH y lo demás (dos columnas del catálogo con DEFAULT constante y su
// CHECK, el destino de la FK a la adenda y las tablas nuevas con FK directa a
// tenants, FK compuestas, RLS FORCE con NULLIF, guardas con la puerta de la
// fusión y sin DELETE para la app). Nada se borra, renombra ni recorre;
// lock_timeout antes de la primera sentencia.

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const ENUM = '20270105090000_dx566_audit_enum';
const INDEX = '20270105090100_dx566_audit_events_idx';
const TABLES = '20270105090200_dx566_post_op_checks';
const ALL = [ENUM, INDEX, TABLES];
const NEW_TABLES = ['post_op_checks', 'post_op_check_attempts'];

describe('DX-566: migraciones aditivas', () => {
  it.each(ALL)('%s fija lock_timeout antes de la primera sentencia', (m) => {
    expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
  });

  it('ninguna borra, renombra, recorre ni toca columnas existentes', () => {
    for (const m of ALL) {
      expect(code(m)).not.toMatch(
        /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|DISABLE\s+TRIGGER|NO\s+FORCE|NOT\s+VALID/im,
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
      `ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'POST_OP_CHECK';`,
    );
  });

  it('el índice parcial de audit_events va por partición, ON ONLY y ATTACH', () => {
    const sql = code(INDEX);
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "audit_events_resource_post_op_check_idx"\s+ON ONLY "audit_events" \("tenantId", "occurredAt" DESC, "id" DESC\)\s+WHERE "resourceType" = 'POST_OP_CHECK';/,
    );
    expect(sql.match(/ATTACH PARTITION/g)).toHaveLength(1);
    expect(sql).not.toMatch(/CONCURRENTLY/);
  });

  it('el catálogo: dos columnas con DEFAULT constante y su CHECK (1–30, solo PROCEDURE)', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    expect(sql).toContain(
      'ALTER TABLE "dental_catalog_items" ADD COLUMN "requiresPostOpCheck" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "postOpCheckAfterDays" SMALLINT NOT NULL DEFAULT 1,',
    );
    expect(sql).toContain(
      `ADD CONSTRAINT "dental_catalog_items_post_op_check" CHECK ( "postOpCheckAfterDays" BETWEEN 1 AND 30 AND (NOT "requiresPostOpCheck" OR "kind" = 'PROCEDURE') );`,
    );
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
    }
    expect(sql).toContain(
      'REVOKE DELETE, TRUNCATE ON "post_op_checks" FROM dentalix_app;',
    );
    expect(sql).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON "post_op_check_attempts" FROM dentalix_app;',
    );
    expect(
      sql.match(
        /NULLIF\(current_setting\('app\.current_tenant', true\), ''\)::uuid/g,
      )!.length,
    ).toBe(4);
  });

  it('FK compuestas por clínica: ítem, cita, evolución y adenda del MISMO paciente; uno PENDING por ítem', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    for (const [col, table] of [
      ['planItemId', 'treatment_plan_items'],
      ['appointmentId', 'appointments'],
      ['clinicalEntryId', 'clinical_entries'],
      ['addendumId', 'clinical_entry_addenda'],
    ]) {
      expect(sql).toContain(
        `FOREIGN KEY ("tenantId", "patientId", "${col}") REFERENCES "${table}"("tenantId", "patientId", "id")`,
      );
    }
    expect(sql).toContain(
      'FOREIGN KEY ("tenantId", "checkId") REFERENCES "post_op_checks"("tenantId", "id")',
    );
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "post_op_checks_pending_item_key" ON "post_op_checks"("tenantId", "planItemId") WHERE "status" = 'PENDING';`,
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "clinical_entry_addenda_tenant_patient_id_key" ON "clinical_entry_addenda"("tenantId", "patientId", "id");',
    );
    // M1: los días del catálogo, congelados al crear el control.
    expect(sql).toContain('"afterDays" SMALLINT NOT NULL,');
    expect(sql).toContain('AND "afterDays" BETWEEN 1 AND 30');
  });

  it('la guarda abre la puerta de la fusión y la lista de la fusión incluye los controles', () => {
    const sql = code(TABLES);
    expect(
      sql.match(/public\.dx_patient_merge_gate\(TG_TABLE_NAME/g),
    ).toHaveLength(1);
    expect(sql).toContain("'post_op_checks.patientId',");
    expect(sql).toContain("'dental_lab_orders.patientId',");
    expect(sql).not.toContain("'post_op_check_attempts.");
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/g)!.length).toBe(5);
  });
});
