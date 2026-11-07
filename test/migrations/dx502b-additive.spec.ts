import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-502-bis: moneda del catálogo explícita por clínica. Aditiva: una columna
// NULL sin DEFAULT en `tenants` (sin RLS) y su FK a `currencies` NOT VALID,
// que valida la siguiente migración. Nada se borra, renombra, rellena ni
// recorre; ningún importe cambia; lock_timeout antes de la primera sentencia.

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const ADD = '20261129090000_dx502b_tenant_catalog_currency';
const VALIDATE = '20261129090100_dx502b_tenant_catalog_currency_fk_validate';

describe('DX-502-bis: migraciones aditivas', () => {
  it.each([ADD, VALIDATE])(
    '%s fija lock_timeout antes de la primera sentencia',
    (m) => {
      expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    },
  );

  it('la primera solo añade la columna NULL y la FK NOT VALID: no borra, rellena ni valida', () => {
    expect(code(ADD)).not.toMatch(
      /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|\bDEFAULT\b|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|VALIDATE|DISABLE\s+TRIGGER|SECURITY\s+DEFINER/im,
    );
    expect(code(ADD)).toContain(
      'ALTER TABLE "tenants" ADD COLUMN "catalogCurrency" CHAR(3);',
    );
    expect(code(ADD)).toMatch(
      /ADD CONSTRAINT "tenants_catalog_currency_fkey"\s+FOREIGN KEY \("catalogCurrency"\) REFERENCES "currencies"\("code"\)\s+ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;/,
    );
  });

  it('la segunda valida exactamente esa FK y nada más', () => {
    expect(
      code(VALIDATE)
        .replace(/^SET LOCAL lock_timeout = '5s';/, '')
        .replace(
          'ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_catalog_currency_fkey";',
          '',
        )
        .trim(),
    ).toBe('');
  });

  it('van después de la última migración de DX-502', () => {
    expect(
      ADD > '20261128090200_dx502_plan_item_catalog_currency_fk_validate',
    ).toBe(true);
  });
});
