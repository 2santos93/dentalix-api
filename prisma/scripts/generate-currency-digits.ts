/**
 * DX-340: genera `prisma/reference/currency-digits.ts`, la referencia
 * versionada de los dos números por moneda que guarda `currencies`:
 *
 *   - `minorUnits` (`currencies.minor_units`): minor units de ISO 4217 según
 *     la List One de SIX (la agencia de mantenimiento de la norma). Es el dato
 *     normativo; Dentalix no lo usa para redondear.
 *   - `roundingDigits` (`currencies.rounding_digits`): decimales a los que
 *     Dentalix redondea cada LÍNEA (descuento en bloque, precio por convenio)
 *     y, con ello, cada total (total = suma de líneas). Congela la regla que
 *     había antes de DX-340 para no cambiar ningún importe: 0 si la moneda no
 *     tenía decimales en CLDR 47 (`cldrDigits` de `iso4217.ts`) o estaba en el
 *     conjunto anterior a G1 (COP, CLP, JPY, KRW, PYG); si no, sus minor units.
 *     Cambiarlo para una moneda es una decisión de producto (migración nueva).
 *
 * Se ejecuta a mano, con la List One descargada, y su salida se revisa y se
 * versiona; no corre en runtime ni en el despliegue:
 *
 *   curl -sSo /tmp/list-one.xml https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
 *   npx ts-node --transpile-only prisma/scripts/generate-currency-digits.ts /tmp/list-one.xml
 *
 * Imprime por stdout los UPDATE de la migración que rellena las columnas.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format as prettier, resolveConfig } from 'prettier';
import { ISO4217_CURRENCIES } from '../reference/iso4217';

/** Las que se cobraban sin decimales antes de G1 (redondeo, no formato). */
const PREVIOUS_ZERO_DECIMAL_SET = new Set(['COP', 'CLP', 'JPY', 'KRW', 'PYG']);

/** Versión de CLDR con la que se generó `iso4217.ts` (su cabecera). */
const PINNED_CLDR = 'CLDR 47.0';

function isoMinorUnits(xml: string): Map<string, string> {
  const units = new Map<string, string>();
  const entry =
    /<Ccy>(\w{3})<\/Ccy>\s*<CcyNbr>\d+<\/CcyNbr>\s*<CcyMnrUnts>([^<]+)<\/CcyMnrUnts>/g;
  for (const [, code, minor] of xml.matchAll(entry)) units.set(code, minor);
  return units;
}

async function main(): Promise<void> {
  const xmlPath = process.argv[2];
  if (!xmlPath)
    throw new Error('Uso: generate-currency-digits.ts <list-one.xml>');
  const reference = readFileSync(
    join(__dirname, '..', 'reference', 'iso4217.ts'),
    'utf8',
  );
  if (!reference.includes(PINNED_CLDR)) {
    throw new Error(
      `iso4217.ts ya no es de ${PINNED_CLDR}: decidir antes los dígitos de redondeo.`,
    );
  }
  const raw = readFileSync(xmlPath);
  const xml = raw.toString('utf8');
  const published = /<ISO_4217 Pblshd="([\d-]+)"/.exec(xml)?.[1];
  if (!published) throw new Error('No es la List One de SIX (falta Pblshd).');
  const units = isoMinorUnits(xml);

  const currencies = ISO4217_CURRENCIES.map(({ code, cldrDigits }) => {
    const minor = units.get(code);
    if (minor === undefined || !/^[0-2]$/.test(minor)) {
      // Decimal(14,2): una moneda de 3 decimales (KWD, BHD…) no cabe.
      throw new Error(`${code}: minor units ISO «${minor ?? 'ausente'}».`);
    }
    const minorUnits = Number(minor);
    const roundingDigits =
      cldrDigits === 0 || PREVIOUS_ZERO_DECIMAL_SET.has(code) ? 0 : minorUnits;
    return { code, minorUnits, roundingDigits };
  });

  const sha256 = createHash('sha256').update(raw).digest('hex');
  const body = currencies
    .map(
      (c) =>
        `  { code: ${JSON.stringify(c.code)}, minorUnits: ${c.minorUnits}, roundingDigits: ${c.roundingDigits} },`,
    )
    .join('\n');
  const source = `// GENERADO por prisma/scripts/generate-currency-digits.ts (DX-340).
// No editar a mano: cambiar el script, volver a generarlo y revisar el diff.
// minorUnits: SIX ISO 4217 List One publicada el ${published}.
// roundingDigits: regla de DX-340 (ver el script).

export const CURRENCY_DIGITS_ISO_SOURCE = {
  list: 'SIX ISO 4217 List One',
  published: '${published}',
  sha256: '${sha256}',
} as const;

export interface CurrencyDigitsReference {
  code: string;
  /** Minor units de ISO 4217 (SIX List One). */
  minorUnits: number;
  /** Decimales a los que Dentalix redondea cada línea (DX-340). */
  roundingDigits: number;
}

export const CURRENCY_DIGITS: readonly CurrencyDigitsReference[] = [
${body}
];
`;
  const target = join(__dirname, '..', 'reference', 'currency-digits.ts');
  writeFileSync(
    target,
    await prettier(source, {
      ...(await resolveConfig(target)),
      filepath: target,
    }),
  );

  const values = (key: 'minorUnits' | 'roundingDigits', digits: number) =>
    currencies
      .filter((c) => c[key] === digits)
      .map((c) => `'${c.code}'`)
      .join(', ');
  process.stdout.write(
    // Primero el redondeo: la CHECK NOT VALID ya vigila las filas que se
    // actualizan (rounding_digits <= minor_units).
    `UPDATE "currencies" SET "rounding_digits" = 0 WHERE "code" IN (${values('roundingDigits', 0)});\n` +
      `UPDATE "currencies" SET "minor_units" = 0 WHERE "code" IN (${values('minorUnits', 0)});\n`,
  );
}

void main();
