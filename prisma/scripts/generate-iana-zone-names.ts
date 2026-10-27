/**
 * G1-B (DX-350): genera la lista de nombres de zona IANA contra la que se
 * canonicaliza la zona de una sede (spec §7).
 *
 * Se ejecuta UNA vez, a mano, y su salida se revisa y se versiona; no corre en
 * runtime ni en el despliegue:
 *
 *   npx ts-node --transpile-only prisma/scripts/generate-iana-zone-names.ts /usr/share/zoneinfo/tzdata.zi
 *
 * Escribe `src/shared/time/iana-zone-names.ts` y
 * `prisma/reference/iana-zone-names.json` (que la web copia byte a byte).
 *
 * Reglas:
 *   - Nombres de las líneas `Z` (zonas) y `L` (enlaces) de `tzdata.zi`: el
 *     nombre del enlace, no su destino. Solo los que `isValidTimeZone` acepta.
 *   - Se les une `Intl.supportedValuesOf('timeZone')`, que en Node 22 no trae
 *     los enlaces (`Asia/Kolkata`, `UTC`).
 *   - Ordenada y sin repetidos.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format as prettier, resolveConfig } from 'prettier';
import { isValidTimeZone } from '../../src/shared/time/civil-day';

function tzdataNames(path: string): { version: string; names: string[] } {
  const lines = readFileSync(path, 'utf8').split('\n');
  const version = /^# version (\S+)/.exec(lines[0] ?? '')?.[1] ?? 'desconocida';
  const names: string[] = [];
  for (const line of lines) {
    const [kind, name, link] = line.split(' ');
    if (kind === 'Z' && name) names.push(name);
    // `L destino nombre`: el nombre del enlace es el tercer campo.
    if (kind === 'L' && link) names.push(link);
  }
  return { version, names };
}

async function write(target: string, text: string): Promise<void> {
  writeFileSync(
    target,
    await prettier(text, {
      ...(await resolveConfig(target)),
      filepath: target,
    }),
  );
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('Uso: generate-iana-zone-names.ts <tzdata.zi>');
  const { version, names } = tzdataNames(path);
  const zones = [...new Set([...names, ...Intl.supportedValuesOf('timeZone')])]
    .filter((zone) => isValidTimeZone(zone))
    .sort();
  const header = [
    '// GENERADO por prisma/scripts/generate-iana-zone-names.ts (G1-B, DX-350).',
    '// No editar a mano: cambiar el script, volver a generarlo y revisar el diff.',
    `// tzdata ${version}, Node ${process.versions.node}, ICU ${process.versions.icu}.`,
  ].join('\n');
  const root = join(__dirname, '..', '..');
  await write(
    join(root, 'src', 'shared', 'time', 'iana-zone-names.ts'),
    `${header}

export const IANA_ZONE_NAMES: readonly string[] = ${JSON.stringify(zones)};
`,
  );
  await write(
    join(root, 'prisma', 'reference', 'iana-zone-names.json'),
    JSON.stringify(zones),
  );
}

void main();
