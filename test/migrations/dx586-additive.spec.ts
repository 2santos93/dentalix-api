import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-586: la tasa al momento llega sin reescribir ni bloquear "payments":
// columnas NULL sin relleno, CHECK NOT VALID validado en su propio fichero, el
// relleno de "effectiveFrom" por clínica y sin DDL, y el NOT NULL y el cambio
// del índice único en otro fichero, en la misma transacción.

const dir = join(__dirname, '..', '..', 'prisma', 'migrations');
const read = (name: string) =>
  readFileSync(join(dir, name, 'migration.sql'), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const statements = (sql: string) =>
  sql
    .replace(/\$\$[\s\S]*?\$\$/g, () => '$$body$$')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');

const SCHEMA = '20270129140000_dx586_rate_moment';
const BACKFILL = '20270129140100_dx586_effective_from_backfill';
const SWAP = '20270129140200_dx586_manual_rates_unique_swap';
const VALIDATE = '20270129140300_dx586_rate_moment_validate';

describe('DX-586: migraciones de la tasa al momento', () => {
  it('el esquema es aditivo: lock_timeout primero, columnas NULL y CHECK NOT VALID', () => {
    const sql = read(SCHEMA);
    expect(statements(sql)[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(sql).toContain(
      'ADD COLUMN "exchangeRateQuotedAt" TIMESTAMPTZ(3), ADD COLUMN "exchangeRateValueDate" DATE, ADD COLUMN "exchangeRateRef" TEXT',
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "payments_exchange_rate_moment_check" CHECK \([\s\S]*\) NOT VALID/,
    );
    expect(sql).toContain('ADD COLUMN "effectiveFrom" TIMESTAMPTZ(3)');
    expect(sql).toContain(
      'ADD CONSTRAINT "manual_exchange_rates_effective_from_check" CHECK ("effectiveFrom" IS NOT NULL) NOT VALID',
    );
    expect(sql).toContain(
      'ADD COLUMN "exchangeRateRefreshedAt" TIMESTAMPTZ(3)',
    );
    expect(sql).not.toMatch(
      /\bDROP\b|\bRENAME\b|DELETE\s+FROM|\bUPDATE "|SECURITY\s+DEFINER|VALIDATE CONSTRAINT|NOT NULL DEFAULT/i,
    );
  });

  it('el relleno no tiene DDL y va clínica a clínica con su tenant', () => {
    const sql = read(BACKFILL);
    expect(statements(sql)).toHaveLength(1);
    expect(sql).toMatch(/^DO \$\$/);
    expect(sql).toContain("set_config('app.current_tenant'");
    expect(sql).toContain('"effectiveFrom" IS NULL');
    expect(sql).not.toMatch(/ALTER\s+TABLE|CREATE\s+INDEX/i);
  });

  it('el NOT NULL y el cambio del único van juntos tras validar el CHECK', () => {
    expect(statements(read(SWAP))).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ALTER TABLE "manual_exchange_rates" VALIDATE CONSTRAINT "manual_exchange_rates_effective_from_check"',
      'ALTER TABLE "manual_exchange_rates" ALTER COLUMN "effectiveFrom" SET NOT NULL',
      'ALTER TABLE "manual_exchange_rates" DROP CONSTRAINT "manual_exchange_rates_effective_from_check"',
      'CREATE UNIQUE INDEX "manual_exchange_rates_tenant_currency_effective_key" ON "manual_exchange_rates"("tenantId", "currency", "effectiveFrom")',
      'CREATE INDEX "manual_exchange_rates_tenant_date_currency_idx" ON "manual_exchange_rates"("tenantId", "date", "currency", "effectiveFrom")',
      'DROP INDEX "manual_exchange_rates_tenant_date_currency_key"',
    ]);
  });

  it('el CHECK de "payments" se valida solo, sin otros bloqueos', () => {
    expect(statements(read(VALIDATE))).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_exchange_rate_moment_check"',
    ]);
  });
});
