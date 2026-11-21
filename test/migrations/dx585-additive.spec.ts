import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-585: la fuente BCV llega sin bloquear ni reescribir nada: el valor del
// enum en su propio fichero (no se puede usar en la transacción que lo crea)
// y una tabla global nueva, sin RLS ni columna de clínica, con sus CHECK en
// el CREATE (vacía: nada que validar) y la app sin DELETE ni TRUNCATE.

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

const ENUM = '20270127140000_dx585_bcv_source_enum';
const TABLE = '20270127140100_dx585_bcv_rate_snapshots';

describe('DX-585: migraciones de la fuente BCV', () => {
  it('el valor del enum va solo, con lock_timeout e IF NOT EXISTS', () => {
    expect(statements(read(ENUM))).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      `ALTER TYPE "ExchangeRateSource" ADD VALUE IF NOT EXISTS 'BCV'`,
    ]);
  });

  it('la tabla es nueva y aditiva: PK por fecha valor, CHECK de tasas y origen, sin tenant ni RLS', () => {
    const sql = read(TABLE);
    const stmts = statements(sql);
    expect(stmts[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(sql).toContain('CREATE TABLE "bcv_rate_snapshots"');
    expect(sql).toContain('"valueDate" DATE NOT NULL');
    expect(sql).toContain('"usdVes" DECIMAL(18,8) NOT NULL');
    expect(sql).toContain('"eurVes" DECIMAL(18,8) NOT NULL');
    expect(sql).toContain('"fetchedAt" TIMESTAMPTZ(3) NOT NULL');
    expect(sql).toContain(
      'CONSTRAINT "bcv_rate_snapshots_pkey" PRIMARY KEY ("valueDate")',
    );
    expect(sql).toContain(
      `CONSTRAINT "bcv_rate_snapshots_origin_check" CHECK ("origin" IN ('BCV', 'FALLBACK'))`,
    );
    expect(sql).toContain(
      'CONSTRAINT "bcv_rate_snapshots_rates_check" CHECK ("usdVes" > 0 AND "eurVes" > 0)',
    );
    expect(sql).not.toMatch(
      /tenantId|ROW LEVEL SECURITY|\bDROP\b|\bRENAME\b|ALTER\s+TABLE|DELETE\s+FROM|\bUPDATE "|SECURITY\s+DEFINER/i,
    );
  });

  it('la app solo lee, inserta y actualiza (sin DELETE ni TRUNCATE)', () => {
    const sql = read(TABLE);
    expect(sql).toContain('REVOKE ALL ON "bcv_rate_snapshots" FROM PUBLIC');
    expect(sql).toMatch(
      /REVOKE ALL ON "bcv_rate_snapshots" FROM dentalix_app; GRANT SELECT, INSERT, UPDATE ON "bcv_rate_snapshots" TO dentalix_app;/,
    );
  });
});
