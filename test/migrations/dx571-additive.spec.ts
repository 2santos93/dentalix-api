import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-571: conciliación contra el extracto del banco. Tres migraciones
// aditivas: los valores de auditoría, su índice parcial por partición y las
// cinco tablas nuevas (nacen vacías: FK dentro del CREATE TABLE), con RLS
// FORCE y NULLIF, FK de tenant RESTRICT, FK compuestas por tenant y sin
// TRUNCATE ni DELETE para la app en lo que es historia.

const dir = (name: string) =>
  join(__dirname, '../../prisma/migrations', name, 'migration.sql');
const code = (name: string): string =>
  readFileSync(dir(name), 'utf8')
    .replace(/--[^\n]*/g, '')
    .trim();

const ENUM = '20270122090000_dx571_audit_enum';
const INDEX = '20270122090100_dx571_audit_events_idx';
const TABLES = '20270122090200_dx571_bank_reconciliation';
const NEW_TABLES = [
  'bank_accounts',
  'bank_account_payment_methods',
  'bank_statement_imports',
  'bank_movements',
  'bank_reconciliation_matches',
];

describe('DX-571: migraciones aditivas', () => {
  it('el enum solo añade los tres valores (IF NOT EXISTS)', () => {
    const sql = code(ENUM);
    expect(
      sql.match(/ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS/g),
    ).toHaveLength(3);
    expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b|CREATE TABLE/);
  });

  it('un índice parcial de audit_events por valor, con la plantilla ON ONLY + ATTACH', () => {
    const sql = code(INDEX);
    expect(sql).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    for (const value of [
      'BANK_ACCOUNT',
      'BANK_STATEMENT_IMPORT',
      'BANK_RECONCILIATION_MATCH',
    ]) {
      const name = `audit_events_resource_${value.toLowerCase()}_idx`;
      expect(sql).toContain(
        `CREATE INDEX IF NOT EXISTS "${name}"\n  ON ONLY "audit_events"`,
      );
      expect(sql).toContain(`WHERE "resourceType" = '${value}'`);
      expect(sql).toContain(`'${name}'`);
    }
    expect(sql.match(/ATTACH PARTITION/g)).toHaveLength(3);
  });

  it('las tablas: lock_timeout primero; nada se borra, renombra ni toca fuera de lo nuevo', () => {
    const sql = code(TABLES);
    expect(sql).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    expect(sql).not.toMatch(
      /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|DISABLE\s+TRIGGER|ALTER\s+TYPE/im,
    );
    const altered = [...sql.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map(
      (m) => m[1],
    );
    expect(new Set(altered)).toEqual(new Set(NEW_TABLES));
    expect(sql).not.toContain('dx_patient_merge_tables');
    expect(sql).not.toMatch(/"patientId"/);
  });

  it('cada tabla: FK de tenant RESTRICT, RLS ENABLE + FORCE con NULLIF y sin TRUNCATE para la app', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    for (const table of NEW_TABLES) {
      expect(sql).toContain(
        `CONSTRAINT "${table}_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT`,
      );
      expect(sql).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
      );
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
      expect(sql).toMatch(
        new RegExp(`REVOKE [A-Z, ]*TRUNCATE ON "${table}" FROM dentalix_app;`),
      );
    }
    expect(
      sql.match(
        /NULLIF\(current_setting\('app\.current_tenant', true\), ''\)::uuid/g,
      ),
    ).toHaveLength(NEW_TABLES.length * 2);
  });

  it('FK compuestas por tenant hacia la cuenta, el medio, el movimiento y el abono', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    for (const [name, target] of [
      [
        'bank_account_payment_methods_account_fkey',
        '"bank_accounts"("tenantId", "id")',
      ],
      [
        'bank_account_payment_methods_method_fkey',
        '"payment_methods"("tenantId", "id")',
      ],
      [
        'bank_statement_imports_account_fkey',
        '"bank_accounts"("tenantId", "id")',
      ],
      ['bank_movements_account_fkey', '"bank_accounts"("tenantId", "id")'],
      [
        'bank_movements_import_fkey',
        '"bank_statement_imports"("tenantId", "id")',
      ],
      [
        'bank_reconciliation_matches_movement_fkey',
        '"bank_movements"("tenantId", "id")',
      ],
      [
        'bank_reconciliation_matches_payment_fkey',
        '"payments"("tenantId", "id")',
      ],
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `CONSTRAINT "${name}" FOREIGN KEY \\("tenantId", "\\w+"\\) REFERENCES ${target.replace(/[()]/g, '\\$&')} ON DELETE RESTRICT`,
        ),
      );
    }
  });

  it('datos de terceros: descripción ≤ 140, referencia ≤ 60, importe > 0; ni fichero ni nombre de fichero', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    expect(sql).toContain('char_length("description") BETWEEN 1 AND 140');
    expect(sql).toContain('char_length(btrim("reference")) BETWEEN 1 AND 60');
    expect(sql).toContain(
      'CONSTRAINT "bank_movements_amount_check" CHECK ("amount" > 0)',
    );
    expect(sql).not.toMatch(/"fileName"|"fileKey"|"content"|"rawRow"/);
  });

  it('idempotencia y 1:1: clave natural única por cuenta; emparejados activos únicos por movimiento y por abono', () => {
    const sql = code(TABLES).replace(/\s+/g, ' ');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "bank_movements_account_key_key" ON "bank_movements"("tenantId", "bankAccountId", "naturalKey");',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "bank_reconciliation_matches_movement_active_key" ON "bank_reconciliation_matches"("tenantId", "movementId") WHERE "endedAt" IS NULL;',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "bank_reconciliation_matches_payment_active_key" ON "bank_reconciliation_matches"("tenantId", "paymentId") WHERE "endedAt" IS NULL;',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "bank_account_payment_methods_method_key"',
    );
  });

  it('funciones con search_path fijo (SEC-032)', () => {
    const sql = code(TABLES);
    const functions = sql.match(/CREATE FUNCTION[\s\S]*?\$\$;/g) ?? [];
    expect(functions).toHaveLength(2);
    for (const fn of functions)
      expect(fn).toContain('SET search_path = pg_catalog, pg_temp');
  });
});
