import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-393: las dos migraciones son aditivas y compatibles con las réplicas
// anteriores: no borran, renombran ni recorren nada, fijan lock_timeout antes
// de la primera sentencia y las funciones conservan SECURITY INVOKER y su
// search_path fijo (SEC-032).

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const GUARDS = '20261105120000_dx393_expense_integrity';
const INDEXES = '20261105120100_dx393_expenses_list_idx';

describe('DX-393: migraciones aditivas', () => {
  it.each([GUARDS, INDEXES])(
    '%s no borra, renombra, cambia tipos ni recorre filas',
    (m) => {
      expect(code(m)).not.toMatch(
        /\bDROP\b|\bRENAME\b|ALTER\s+(TABLE|COLUMN)|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|VALIDATE/im,
      );
    },
  );

  it.each([GUARDS, INDEXES])(
    '%s fija lock_timeout antes de la primera sentencia',
    (m) => {
      expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    },
  );

  it('las guardas reemplazan las tres funciones con su search_path, sin SECURITY DEFINER', () => {
    const sql = code(GUARDS);
    for (const fn of [
      'dx_expense_guard',
      'dx_expense_payment_guard',
      'dx_cash_adjustment_guard',
    ]) {
      expect(sql).toContain(
        `CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger\n  LANGUAGE plpgsql\n  SET search_path = pg_catalog, pg_temp`,
      );
    }
    expect(sql).not.toMatch(/SECURITY\s+DEFINER|CREATE\s+TRIGGER/i);
    for (const state of ['Q3930', 'Q3931', 'Q3932', 'Q3933', 'Q3934']) {
      expect(sql).toContain(`ERRCODE = '${state}'`);
    }
  });

  it('los índices tienen el orden exacto de la lista de gastos', () => {
    expect(code(INDEXES)).toContain(
      'ON "expenses"("tenantId", "invoiceDate" DESC, "createdAt" DESC, "id" DESC);',
    );
    expect(code(INDEXES)).toContain(
      'ON "expenses"("tenantId", "locationId", "invoiceDate" DESC, "createdAt" DESC, "id" DESC);',
    );
  });
});
