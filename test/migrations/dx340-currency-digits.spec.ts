import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENCY_DIGITS } from '../../prisma/reference/currency-digits';

// DX-340: `currencies.minor_units` (ISO 4217, SIX List One) y
// `currencies.rounding_digits` (redondeo por línea de Dentalix) se añaden con
// valor por defecto y CHECK NOT VALID en una migración, y se rellenan desde
// la referencia versionada y se validan en la siguiente (DB-029). Aditivas:
// no borran, renombran ni cambian tipos; ningún importe guardado se toca.

const code = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

const ADD = '20261111100000_dx340_currency_digits';
const BACKFILL = '20261111100100_dx340_currency_digits_backfill';

function codesIn(sql: string, column: string): string[] {
  const match = new RegExp(
    `UPDATE "currencies" SET "${column}" = 0 WHERE "code" IN \\(([^)]*)\\);`,
  ).exec(sql);
  return (match?.[1] ?? '')
    .split(',')
    .map((c) => c.trim().replace(/'/g, ''))
    .filter(Boolean)
    .sort();
}

describe('DX-340: migraciones de los decimales por moneda', () => {
  it.each([ADD, BACKFILL])(
    '%s fija lock_timeout antes de la primera sentencia',
    (m) => {
      expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    },
  );

  it('la primera solo añade columnas con valor por defecto y CHECK NOT VALID', () => {
    const sql = code(ADD);
    expect(sql).not.toMatch(
      /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|VALIDATE/im,
    );
    expect(sql).toMatch(/ADD COLUMN "minor_units" SMALLINT NOT NULL DEFAULT 2/);
    expect(sql).toMatch(
      /ADD COLUMN "rounding_digits" SMALLINT NOT NULL DEFAULT 2/,
    );
    const checks = [
      ...sql.matchAll(
        /ADD CONSTRAINT "(\w+)"\s+CHECK \(([\s\S]*?)\) NOT VALID;/g,
      ),
    ];
    expect(checks.map((m) => m[1])).toEqual([
      'currencies_minor_units_check',
      'currencies_rounding_digits_check',
    ]);
    // Decimal(14,2): ninguna moneda puede tener más de 2 decimales.
    expect(checks[0][2]).toMatch(/"minor_units" BETWEEN 0 AND 2/);
    expect(checks[1][2]).toMatch(
      /"rounding_digits" BETWEEN 0 AND "minor_units"/,
    );
  });

  it('la segunda rellena exactamente lo que dice la referencia y valida las CHECK', () => {
    const sql = code(BACKFILL);
    const zero = (key: 'minorUnits' | 'roundingDigits') =>
      CURRENCY_DIGITS.filter((c) => c[key] === 0)
        .map((c) => c.code)
        .sort();
    expect(codesIn(sql, 'minor_units')).toEqual(zero('minorUnits'));
    expect(codesIn(sql, 'rounding_digits')).toEqual(zero('roundingDigits'));
    // Solo toca la tabla de referencia: ningún importe ni documento.
    expect(
      [...sql.matchAll(/^\s*UPDATE\s+"(\w+)"/gim)].map((m) => m[1]),
    ).toEqual(['currencies', 'currencies']);
    expect(
      [...sql.matchAll(/VALIDATE CONSTRAINT "(\w+)";/g)].map((m) => m[1]),
    ).toEqual([
      'currencies_minor_units_check',
      'currencies_rounding_digits_check',
    ]);
  });
});
