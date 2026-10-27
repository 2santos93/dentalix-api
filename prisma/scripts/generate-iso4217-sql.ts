/**
 * GLOBAL-G1 (DX-313): genera la lista de monedas ISO 4217 que acepta Dentalix.
 *
 * Se ejecuta UNA vez, a mano, y su salida se revisa y se versiona; no corre en
 * runtime ni en el despliegue:
 *
 *   npx ts-node --transpile-only prisma/scripts/generate-iso4217-sql.ts
 *
 * Escribe `prisma/reference/iso4217.ts` (lo leen `prisma/seed.ts` y los tests)
 * y `prisma/reference/iso4217-zero-decimal.json` (G1-B: lo copia la web) e
 * imprime por stdout el `INSERT … ON CONFLICT (code) DO NOTHING` que se pega
 * en la migración `…_g1_location_regional_settings`.
 *
 * Reglas (spec GLOBAL-G1 §2.2.1 y R7):
 *   - Fuente: `Intl.supportedValuesOf('currency')` del runtime (Node 22, ICU de
 *     su versión). Nombre: `Intl.DisplayNames('es', { type: 'currency' })`,
 *     con la primera letra en mayúscula como las monedas ya sembradas. Símbolo:
 *     `narrowSymbol` de `Intl.NumberFormat('es', …)`.
 *   - `minorUnits` = dígitos de CLDR (`maximumFractionDigits`), no los de ISO:
 *     se eligen a propósito porque son los que usará el formato con `Intl`.
 *   - Fuera los fondos y unidades de cuenta `X**` (XDR, XSU…), salvo las
 *     monedas en circulación XAF, XOF, XPF, XCD y XCG (florín caribeño, que
 *     sustituye al ANG desde 2025; no es un fondo ni un metal).
 *   - Fuera las monedas de 3 decimales ISO: los importes son `Decimal(14,2)`
 *     y no las representan (decisión 5 del dueño).
 *   - Fuera los códigos retirados por ISO que `Intl` todavía devuelve.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format as prettier, resolveConfig } from 'prettier';

/** Las que se cobraban sin decimales antes de G1: solo cuentan para redondear. */
const PREVIOUS_ZERO_DECIMAL_SET = ['COP', 'CLP', 'JPY', 'KRW', 'PYG'];

/** Monedas en circulación con código `X**` (las demás son fondos o metales). */
const X_CURRENCIES_IN_CIRCULATION = new Set([
  'XAF',
  'XOF',
  'XPF',
  'XCD',
  'XCG',
]);

/** ISO 4217 con 3 decimales: no caben en `Decimal(14,2)`. */
const THREE_DECIMAL_CURRENCIES = new Set([
  'BHD',
  'IQD',
  'JOD',
  'KWD',
  'LYD',
  'OMR',
  'TND',
]);

/** Retiradas por ISO 4217 (fecha de retirada ya pasada) que `Intl` aún lista. */
const WITHDRAWN_CURRENCIES: Record<string, string> = {
  ANG: 'sustituida por XCG (2025)',
  BGN: 'Bulgaria adopta el euro (2026)',
  CUC: 'retirada en 2021',
  HRK: 'Croacia adopta el euro (2023)',
  SLL: 'sustituida por SLE',
  ZWL: 'sustituida por ZWG (2024)',
};

/** Símbolos ya sembrados (20260727130000_seed_currencies) que se conservan. */
const SYMBOL_OVERRIDES: Record<string, string> = { PEN: 'S/' };

/** Nombres que `Intl.DisplayNames('es')` no resuelve (devuelve el código). */
const NAME_OVERRIDES: Record<string, string> = { ZWG: 'Oro de Zimbabue' };

interface Iso4217Currency {
  code: string;
  name: string;
  symbol: string;
  minorUnits: number;
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase('es') + text.slice(1);
}

function build(): Iso4217Currency[] {
  const names = new Intl.DisplayNames('es', { type: 'currency' });
  return Intl.supportedValuesOf('currency')
    .filter(
      (code) => !code.startsWith('X') || X_CURRENCIES_IN_CIRCULATION.has(code),
    )
    .filter((code) => !THREE_DECIMAL_CURRENCIES.has(code))
    .filter((code) => !(code in WITHDRAWN_CURRENCIES))
    .map((code) => {
      const format = new Intl.NumberFormat('es', {
        style: 'currency',
        currency: code,
        currencyDisplay: 'narrowSymbol',
      });
      const name = NAME_OVERRIDES[code] ?? capitalize(names.of(code) ?? code);
      if (name === code || /\(\d{4}/.test(name)) {
        throw new Error(
          `Moneda ${code}: nombre sin resolver o histórico («${name}»).`,
        );
      }
      const symbol =
        SYMBOL_OVERRIDES[code] ??
        format.formatToParts(1).find((part) => part.type === 'currency')
          ?.value ??
        code;
      return {
        code,
        name,
        symbol,
        minorUnits: format.resolvedOptions().maximumFractionDigits ?? 2,
      };
    });
}

const sqlText = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Mismo formato que el JSON de la web: filas de 10 códigos, lista previa en línea. */
function zeroDecimalJson(currencies: Iso4217Currency[]): string {
  const zero = currencies.filter((c) => c.minorUnits === 0).map((c) => c.code);
  const rows: string[] = [];
  for (let i = 0; i < zero.length; i += 10) {
    rows.push(
      '    ' +
        zero
          .slice(i, i + 10)
          .map((code) => JSON.stringify(code))
          .join(', '),
    );
  }
  const previous = PREVIOUS_ZERO_DECIMAL_SET.map((c) => JSON.stringify(c));
  return `{\n  "minorUnitsZero": [\n${rows.join(',\n')}\n  ],\n  "previousSet": [${previous.join(', ')}]\n}\n`;
}

async function main(): Promise<void> {
  const currencies = build();
  const target = join(__dirname, '..', 'reference', 'iso4217.ts');
  const header = [
    '// GENERADO por prisma/scripts/generate-iso4217-sql.ts (GLOBAL-G1, DX-313).',
    '// No editar a mano: cambiar el script, volver a generarlo y revisar el diff.',
    `// Node ${process.versions.node}, ICU ${process.versions.icu}, CLDR ${process.versions.cldr}.`,
    '// `minorUnits` = dígitos de CLDR (los que usa `Intl` al formatear).',
  ].join('\n');
  const body = currencies
    .map(
      (c) =>
        `  { code: ${JSON.stringify(c.code)}, name: ${JSON.stringify(c.name)}, symbol: ${JSON.stringify(c.symbol)}, minorUnits: ${c.minorUnits} },`,
    )
    .join('\n');
  const source = `${header}

export interface Iso4217Currency {
  code: string;
  name: string;
  symbol: string;
  minorUnits: number;
}

export const ISO4217_CURRENCIES: readonly Iso4217Currency[] = [
${body}
];
`;
  writeFileSync(
    target,
    await prettier(source, {
      ...(await resolveConfig(target)),
      filepath: target,
    }),
  );
  writeFileSync(
    join(__dirname, '..', 'reference', 'iso4217-zero-decimal.json'),
    zeroDecimalJson(currencies),
  );
  const values = currencies
    .map(
      (c) => `  (${sqlText(c.code)}, ${sqlText(c.name)}, ${sqlText(c.symbol)})`,
    )
    .join(',\n');
  process.stdout.write(
    `INSERT INTO "currencies" ("code", "name", "symbol") VALUES\n${values}\nON CONFLICT ("code") DO NOTHING;\n`,
  );
}

void main();
