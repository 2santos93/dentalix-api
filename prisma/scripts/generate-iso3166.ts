/**
 * DX-312: genera la lista de países ISO 3166-1 de la tabla `countries`.
 *
 * Se ejecuta UNA vez, a mano, con Node 22, y su salida se revisa y se
 * versiona; no corre en runtime ni en el despliegue:
 *
 *   npx ts-node --transpile-only prisma/scripts/generate-iso3166.ts
 *
 * Escribe `prisma/reference/iso3166.ts` (lo leen `prisma/seed.ts` y los tests)
 * y `prisma/reference/iso3166-countries.json` (lo copia la web byte a byte) e
 * imprime por stdout el `INSERT … ON CONFLICT ("code") DO UPDATE` que se pega
 * en la migración `…_dx312_location_country_code`.
 *
 * Reglas (spec DX-312 R8 y §3.5):
 *   - Códigos: `Country.getAllCountries()` de `country-state-city` (la versión
 *     de `package-lock.json`), la misma fuente que llenaba la tabla, para que
 *     no desaparezca ninguna fila que referencien `patients` o `cities`.
 *   - Nombres: `Intl.DisplayNames('es', { type: 'region' })` del runtime, con
 *     la primera letra en mayúscula como las monedas.
 *   - Falla si un código no es `^[A-Z]{2}$`, si un nombre sale igual al código
 *     o si hay códigos repetidos. Ordenada por código; nada más.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Country } from 'country-state-city';
import { format as prettier, resolveConfig } from 'prettier';

interface Iso3166Country {
  code: string;
  name: string;
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase('es') + text.slice(1);
}

function build(): Iso3166Country[] {
  const names = new Intl.DisplayNames('es', { type: 'region' });
  const countries = Country.getAllCountries().map(({ isoCode: code }) => {
    if (!/^[A-Z]{2}$/.test(code)) {
      throw new Error(`País «${code}»: no es un código ISO 3166-1 alfa-2.`);
    }
    const name = capitalize(names.of(code) ?? code);
    if (name === code) {
      throw new Error(`País ${code}: nombre sin resolver.`);
    }
    return { code, name };
  });
  const codes = countries.map((c) => c.code);
  const repeated = codes.filter((code, i) => codes.indexOf(code) !== i);
  if (repeated.length > 0) {
    throw new Error(`Códigos repetidos: ${repeated.join(', ')}.`);
  }
  return countries.sort((a, b) => (a.code < b.code ? -1 : 1));
}

/** Versión instalada, leída de `package-lock.json` (la que fija la lista). */
function packageVersion(name: string): string {
  const lock = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'package-lock.json'), 'utf8'),
  ) as { packages: Record<string, { version?: string }> };
  const version = lock.packages[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`${name} no está en package-lock.json.`);
  return version;
}

const sqlText = (value: string): string => `'${value.replace(/'/g, "''")}'`;

async function main(): Promise<void> {
  const countries = build();
  const reference = join(__dirname, '..', 'reference');
  const target = join(reference, 'iso3166.ts');
  const header = [
    '// GENERADO por prisma/scripts/generate-iso3166.ts (DX-312).',
    '// No editar a mano: cambiar el script, volver a generarlo y revisar el diff.',
    `// country-state-city ${packageVersion('country-state-city')}, Node ${process.versions.node}, ICU ${process.versions.icu}, CLDR ${process.versions.cldr}.`,
    '// Excepción G5.3 (DX-334): lista de referencia de países; ningún código la cura ni la ordena por preferencia.',
    `// Códigos: country-state-city (GPL-3.0); son hechos de la norma ISO 3166-1, no se copia código del paquete. Nombres: CLDR ${process.versions.cldr} (Unicode License v3).`,
  ].join('\n');
  const body = countries
    .map(
      (c) =>
        `  { code: ${JSON.stringify(c.code)}, name: ${JSON.stringify(c.name)} },`,
    )
    .join('\n');
  const source = `${header}

export interface Iso3166Country {
  code: string;
  name: string;
}

export const ISO3166_COUNTRIES: readonly Iso3166Country[] = [
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
    join(reference, 'iso3166-countries.json'),
    JSON.stringify(countries, null, 2) + '\n',
  );
  const values = countries
    .map((c) => `  (${sqlText(c.code)}, ${sqlText(c.name)})`)
    .join(',\n');
  process.stdout.write(
    `INSERT INTO "countries" ("code", "name") VALUES\n${values}\nON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name";\n`,
  );
}

void main();
