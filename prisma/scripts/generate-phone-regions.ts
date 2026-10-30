/**
 * DX-329: genera la lista de regiones de numeración de `libphonenumber-js`.
 *
 * Se ejecuta UNA vez, a mano, con Node 22.16.0, y su salida se revisa y se
 * versiona; no corre en runtime ni en el despliegue:
 *
 *   npx ts-node --transpile-only prisma/scripts/generate-phone-regions.ts
 *
 * Escribe `prisma/reference/phone-regions.ts` (lo leen los tests) y
 * `prisma/reference/phone-regions-list.json` (lo copia la web byte a byte). Si se
 * sube la librería sin volver a generarla, falla
 * `src/shared/phone/phone-regions.spec.ts`.
 *
 * Reglas (spec DX-329 §3.2):
 *   - Regiones: `getCountries()` de la versión instalada, sin curar; cada una
 *     con su indicativo, `getCountryCallingCode()`.
 *   - Nombres: `Intl.DisplayNames('es', { type: 'region' })` del runtime, con
 *     la primera letra en mayúscula como la lista ISO.
 *   - Falla si un código no es `^[A-Z]{2}$`, si un indicativo no es
 *     `^\d{1,3}$`, si un nombre sale igual al código o si hay códigos
 *     repetidos. Ordenada por código; nada más.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCountries, getCountryCallingCode } from 'libphonenumber-js/max';
import { format as prettier, resolveConfig } from 'prettier';

interface PhoneRegionReference {
  code: string;
  name: string;
  callingCode: string;
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase('es') + text.slice(1);
}

function build(): PhoneRegionReference[] {
  const names = new Intl.DisplayNames('es', { type: 'region' });
  const regions = getCountries().map((code) => {
    if (!/^[A-Z]{2}$/.test(code)) {
      throw new Error(`Región «${code}»: no es un código de dos letras.`);
    }
    const callingCode = getCountryCallingCode(code);
    if (!/^\d{1,3}$/.test(callingCode)) {
      throw new Error(`Región ${code}: indicativo «${callingCode}» no válido.`);
    }
    const name = capitalize(names.of(code) ?? code);
    if (name === code) {
      throw new Error(`Región ${code}: nombre sin resolver.`);
    }
    return { code, name, callingCode };
  });
  const codes = regions.map((r) => r.code);
  const repeated = codes.filter((code, i) => codes.indexOf(code) !== i);
  if (repeated.length > 0) {
    throw new Error(`Códigos repetidos: ${repeated.join(', ')}.`);
  }
  return regions.sort((a, b) => (a.code < b.code ? -1 : 1));
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

async function main(): Promise<void> {
  const regions = build();
  const reference = join(__dirname, '..', 'reference');
  const target = join(reference, 'phone-regions.ts');
  const header = [
    '// GENERADO por prisma/scripts/generate-phone-regions.ts (DX-329).',
    '// No editar a mano: cambiar el script, volver a generarlo y revisar el diff.',
    `// libphonenumber-js ${packageVersion('libphonenumber-js')}, Node ${process.versions.node}, ICU ${process.versions.icu}, CLDR ${process.versions.cldr}.`,
    '// Lista de referencia de regiones de numeración; ningún código la cura ni la ordena por preferencia.',
    `// Regiones e indicativos: libphonenumber-js (MIT), sobre los metadatos de libphonenumber (Apache-2.0). Nombres: CLDR ${process.versions.cldr} (Unicode License v3).`,
  ].join('\n');
  const body = regions
    .map(
      (r) =>
        `  { code: ${JSON.stringify(r.code)}, name: ${JSON.stringify(r.name)}, callingCode: ${JSON.stringify(r.callingCode)} },`,
    )
    .join('\n');
  const source = `${header}

export interface PhoneRegionReference {
  code: string;
  name: string;
  callingCode: string;
}

export const PHONE_REGIONS: readonly PhoneRegionReference[] = [
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
    join(reference, 'phone-regions-list.json'),
    JSON.stringify(regions, null, 2) + '\n',
  );
}

void main();
