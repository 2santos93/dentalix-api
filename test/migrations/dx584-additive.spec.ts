import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-584: las monedas de la clínica llegan sin bloquear ni reescribir
// `tenants` y sin cambiar el comportamiento de ninguna clínica: columnas
// nuevas ('{}' constante y NULL), sin relleno, CHECK y FK NOT VALID con
// lock_timeout, y la validación aparte. La función del CHECK es IMMUTABLE con
// search_path fijo (SEC-032).

const dir = join(__dirname, '..', '..', 'prisma', 'migrations');
const read = (name: string) =>
  readFileSync(join(dir, name, 'migration.sql'), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
/** Sentencias de nivel superior (sin partir los cuerpos $$ … $$). */
const statements = (sql: string) =>
  sql
    .replace(/\$\$[\s\S]*?\$\$/g, () => '$$body$$')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');

const SCHEMA = '20270126140000_dx584_clinic_currencies';
const VALIDATE = '20270126140100_dx584_validate';

describe('DX-584: migraciones de las monedas de la clínica', () => {
  it('el esquema empieza con lock_timeout y solo añade: columnas, función, CHECK y FK NOT VALID', () => {
    const sql = read(SCHEMA);
    const stmts = statements(sql);
    expect(stmts[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(sql).toContain(
      'ADD COLUMN "acceptedCurrencies" CHAR(3)[] NOT NULL DEFAULT ARRAY[]::CHAR(3)[]',
    );
    expect(sql).toContain('ADD COLUMN "rateReferenceCurrency" CHAR(3),');
    expect(sql).toContain('ADD COLUMN "showRateInHeader" BOOLEAN;');
    expect(sql).toMatch(
      /ADD CONSTRAINT "tenants_accepted_currencies_check" CHECK \(public\.dx_currency_list_ok\("acceptedCurrencies"\)\) NOT VALID/,
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "tenants_rate_reference_currency_fkey" FOREIGN KEY \("rateReferenceCurrency"\) REFERENCES "currencies"\("code"\) ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID/,
    );
    expect(sql).not.toMatch(
      /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|DELETE\s+FROM|^\s*UPDATE\b|\bUPDATE "tenants"|VALIDATE|SECURITY\s+DEFINER/im,
    );
  });

  it('la función del CHECK es IMMUTABLE y fija el search_path', () => {
    const sql = read(SCHEMA);
    expect(sql).toMatch(
      /CREATE FUNCTION public\.dx_currency_list_ok\(codes bpchar\[\]\) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS \$\$/,
    );
  });

  it('la validación va aparte, con lock_timeout y sin NO FORCE (tenants no tiene RLS)', () => {
    expect(statements(read(VALIDATE))).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_accepted_currencies_check"',
      'ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_rate_reference_currency_fkey"',
    ]);
  });
});
