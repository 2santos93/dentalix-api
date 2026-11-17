import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-091: cierre contable. Dos migraciones aditivas: columnas de tenants (el
// CHECK de los días NOT VALID y validado aparte), la tabla append-only de
// excepciones (FK directa a tenants, FK compuestas por clínica, RLS FORCE
// con NULLIF) y la guarda de payments. Nada se borra, renombra ni recorre.

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const MAIN = '20261231090000_dx091_financial_lock';
const VALIDATE = '20261231090100_dx091_validate';

describe('DX-091: migraciones aditivas', () => {
  it.each([MAIN, VALIDATE])(
    '%s fija lock_timeout antes de la primera sentencia',
    (m) => {
      expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    },
  );

  it('ninguna borra, renombra, recorre ni toca columnas existentes', () => {
    for (const m of [MAIN, VALIDATE]) {
      expect(code(m)).not.toMatch(
        /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|DISABLE\s+TRIGGER/im,
      );
    }
  });

  it('el CHECK de los días entra NOT VALID y se valida en su propia migración', () => {
    expect(code(MAIN)).toMatch(
      /ADD CONSTRAINT "tenants_financial_lock_days_check"[\s\S]*?NOT VALID;/,
    );
    expect(code(VALIDATE)).toContain(
      'ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_financial_lock_days_check";',
    );
  });

  it('financial_lock_overrides: FK a tenants RESTRICT, FK compuestas, RLS FORCE con NULLIF y append-only', () => {
    const sql = code(MAIN);
    expect(sql).toMatch(
      /"financial_lock_overrides_tenantId_fkey" FOREIGN KEY \("tenantId"\)\s+REFERENCES "tenants"\("id"\) ON DELETE RESTRICT/,
    );
    for (const target of ['locations', 'payments', 'payment_plans']) {
      expect(sql).toMatch(
        new RegExp(
          `REFERENCES "${target}"\\("tenantId", "id"\\) ON DELETE RESTRICT`,
        ),
      );
    }
    expect(sql).toContain(
      'ALTER TABLE "financial_lock_overrides" ENABLE ROW LEVEL SECURITY;',
    );
    expect(sql).toContain(
      'ALTER TABLE "financial_lock_overrides" FORCE ROW LEVEL SECURITY;',
    );
    expect(sql).toMatch(
      /CREATE POLICY tenant_isolation ON "financial_lock_overrides"\s+USING \("tenantId" = NULLIF\(current_setting\('app.current_tenant', true\), ''\)::uuid\)/,
    );
    expect(sql).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON "financial_lock_overrides" FROM dentalix_app;',
    );
  });

  it('la guarda de payments solo mira el alta y el paso a anulado, con SQLSTATE propio', () => {
    const sql = code(MAIN);
    expect(sql).toContain(
      'BEFORE INSERT OR UPDATE OF "deletedAt" ON "payments"',
    );
    expect(sql).toContain("USING ERRCODE = 'Q0910'");
    expect(sql).toContain('SET search_path = pg_catalog, pg_temp');
  });
});
