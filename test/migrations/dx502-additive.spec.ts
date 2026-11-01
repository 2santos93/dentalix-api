import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-502: la moneda del catálogo del ítem llega sin bloquear ni reescribir
// `treatment_plan_items`. Esquema (columna NULL sin DEFAULT, FK NOT VALID y
// triggers) con lock_timeout; relleno en una migración propia de UNA
// sentencia DO con COMMIT por lote, clínica fijada y sin DDL ni NO FORCE; y la
// validación de la FK aparte, con NO FORCE/FORCE de la hija (DX-134).

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

const SCHEMA = '20261111180000_dx502_plan_item_catalog_currency';
const BACKFILL = '20261111180100_dx502_plan_item_catalog_currency_backfill';
const VALIDATE = '20261111180200_dx502_plan_item_catalog_currency_fk_validate';

describe('DX-502: migraciones de treatment_plan_items."catalogCurrency"', () => {
  it('el esquema empieza con lock_timeout, añade la columna NULL sin DEFAULT y la FK NOT VALID; no borra ni recorre filas', () => {
    const sql = read(SCHEMA);
    const stmts = statements(sql);
    expect(stmts[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(stmts).toContain(
      'ALTER TABLE "treatment_plan_items" ADD COLUMN "catalogCurrency" CHAR(3)',
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "treatment_plan_items_catalog_currency_fkey" FOREIGN KEY \("catalogCurrency"\) REFERENCES "currencies"\("code"\) ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID/,
    );
    expect(sql).not.toMatch(
      /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|DEFAULT|DELETE\s+FROM|^\s*UPDATE\b|VALIDATE|SECURITY\s+DEFINER/im,
    );
  });

  it('las funciones de los triggers fijan el search_path', () => {
    const sql = read(SCHEMA);
    const functions = sql.match(/FUNCTION public\."\w+"\(\) RETURNS trigger/g);
    expect(functions).toHaveLength(2);
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(2);
    expect(sql).toMatch(
      /CREATE TRIGGER "treatment_plan_items_catalog_currency_frozen" BEFORE UPDATE OF "catalogCurrency" ON "treatment_plan_items"/,
    );
  });

  it('el relleno es UNA sentencia DO, con COMMIT por lote, clínica fijada, lock_timeout e idempotente; sin NO FORCE ni DDL', () => {
    const sql = read(BACKFILL);
    const stmts = statements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatch(/^DO \$\$body\$\$$/);
    expect(sql).toMatch(/COMMIT;/);
    expect(sql).toMatch(/set_config\('app\.current_tenant', t::text, true\)/);
    expect(sql).toMatch(/set_config\('lock_timeout', '\d+s', true\)/);
    expect(sql).toMatch(/i\."catalogCurrency" IS NULL/);
    expect(sql).toMatch(/LIMIT \d+/);
    expect(sql).not.toMatch(
      /FORCE ROW LEVEL SECURITY|ALTER TABLE|CREATE |DROP /i,
    );
  });

  it('la validación de la FK quita y devuelve FORCE a la hija en la misma migración', () => {
    expect(statements(read(VALIDATE))).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ALTER TABLE "treatment_plan_items" NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_catalog_currency_fkey"',
      'ALTER TABLE "treatment_plan_items" FORCE ROW LEVEL SECURITY',
    ]);
  });
});
