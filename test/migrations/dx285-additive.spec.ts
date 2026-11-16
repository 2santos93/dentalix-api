import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-285: cobro de ortodoncia y alineadores. Dos migraciones aditivas: las
// columnas y tablas nuevas (FK directa a tenants, FK compuestas por tenant y
// por caso, RLS FORCE con NULLIF, append-only por REVOKE) y el VALIDATE de
// los CHECK en su propio fichero. Nada se borra, renombra ni recorre;
// lock_timeout antes de la primera sentencia; las FK sobre ortho_cases se
// añaden con FORCE quitado y devuelto en la misma migración (DX-134).

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const TABLES = '20261230120000_dx285_ortho_billing';
const VALIDATE = '20261230120100_dx285_validate';
const NEW_TABLES = [
  'ortho_case_charges',
  'ortho_aligner_series',
  'ortho_aligner_deliveries',
];

describe('DX-285: migraciones aditivas', () => {
  it.each([TABLES, VALIDATE])(
    '%s fija lock_timeout antes de la primera sentencia',
    (m) => {
      expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    },
  );

  it('ninguna borra, renombra, recorre ni toca columnas existentes', () => {
    for (const m of [TABLES, VALIDATE]) {
      expect(code(m)).not.toMatch(
        /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|DISABLE\s+TRIGGER/im,
      );
    }
  });

  it('cada NO FORCE vuelve a FORCE en la misma migración', () => {
    const sql = code(TABLES);
    for (const table of ['ortho_cases', 'payment_plans']) {
      const off = sql.indexOf(
        `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY;`,
      );
      const on = sql.lastIndexOf(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
      );
      expect(off).toBeGreaterThan(-1);
      expect(on).toBeGreaterThan(off);
    }
  });

  it.each(NEW_TABLES)(
    '%s: FK directa a tenants RESTRICT y RLS ENABLE + FORCE con NULLIF',
    (table) => {
      const sql = code(TABLES);
      expect(sql).toContain(
        `CONSTRAINT "${table}_tenantId_fkey"\n      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT`,
      );
      expect(sql).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
      );
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
      expect(sql).toMatch(
        new RegExp(
          `CREATE POLICY tenant_isolation ON "${table}"\\s+USING \\("tenantId" = NULLIF\\(current_setting\\('app.current_tenant', true\\), ''\\)::uuid\\)`,
        ),
      );
    },
  );

  it('las series y las entregas son append-only y los cargos no se borran', () => {
    const sql = code(TABLES);
    expect(sql).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON "ortho_aligner_series" FROM dentalix_app;',
    );
    expect(sql).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON "ortho_aligner_deliveries" FROM dentalix_app;',
    );
    expect(sql).toContain(
      'REVOKE DELETE, TRUNCATE ON "ortho_case_charges" FROM dentalix_app;',
    );
  });

  it('el CHECK del reparto va NOT VALID y se valida en su propio fichero', () => {
    expect(code(TABLES)).toMatch(
      /"feeTotal" = "feeInitial" \+ "feePerVisit" \* "feeVisitCount" \+ "feeRetention"\s+\)\s+\) NOT VALID;/,
    );
    expect(code(VALIDATE)).toContain(
      'ALTER TABLE "ortho_cases" VALIDATE CONSTRAINT "ortho_cases_fee_check";',
    );
  });
});
