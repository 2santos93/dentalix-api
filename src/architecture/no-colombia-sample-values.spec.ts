import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Dueño (2026-11-02): Dentalix es mundial y su primer mercado es Venezuela.
 * Cuando una prueba, un dato de muestra, la configuración o la documentación
 * necesita un valor de ejemplo, es Venezuela y USD, nunca Colombia. Amplía la
 * guarda «sin Colombia» de DX-323/325, que solo mira producción, a TODO lo
 * versionado en este repo. Los términos se arman por partes para que este
 * fichero no se delate a sí mismo; la autoprueba fija que cada uno se detecta.
 */
const REPO_ROOT = join(__dirname, '..', '..');

/**
 * Las únicas excepciones. Un producto mundial ofrece Colombia como cualquier
 * país, y lo ya aplicado no se reescribe.
 */
const EXCLUDED: readonly RegExp[] = [
  // Migraciones ya aplicadas: su checksum no se cambia.
  /^prisma\/migrations\//,
  // Catálogos ISO y de datos del mundo, y lo que los genera.
  /^prisma\/reference\/(?:iso3166|iso4217|iana-zone-names|phone-regions|country-regional|currency-digits)/,
  /^prisma\/scripts\/generate-currency-digits\.ts$/,
  /^src\/shared\/time\/iana-zone-names\.ts$/,
  // Foto literal de la regla de redondeo anterior a DX-340.
  /^src\/shared\/money\/__fixtures__\/pre-dx340-oracle\.ts$/,
  // Pruebas de migraciones ya aplicadas: el SQL impone sus literales.
  /^test\/location-country-code-migration\.int-spec\.ts$/,
  /^test\/location-regional-settings-migration\.int-spec\.ts$/,
  /^test\/owner-nosu\/migrations-data\.owner-spec\.ts$/,
  // Guardas: siembran justo lo que prohíben.
  /^src\/architecture\/no-location-fallbacks\.spec\.ts$/,
  /^src\/architecture\/no-colombia-sample-values\.spec\.ts$/,
  // DX-334: la guarda de supuestos de país y sus excepciones nombran los catálogos.
  /^src\/architecture\/no-country-assumptions\.spec\.ts$/,
  /^src\/architecture\/country-assumptions\.exceptions\.json$/,
];

/**
 * Fuera de la guarda a propósito, y sin excepción que declarar: el código `'CO'`
 * del enum legado `ClinicCountry`, que solo admite CO/ES y que aquí no se
 * busca. Sigue en `LEGACY_ENUM_COUNTRY` (test/support/location-fixtures.ts,
 * sedes anteriores a DX-312) y en las recetas legadas de `prescriptions`: el
 * CHECK `prescriptions_legacy_country_fields_check` exige esa forma histórica.
 */
/** El nombre de una migración ya aplicada no es un valor de ejemplo. */
const APPLIED_MIGRATION_NAME = /sin[_-]colombia[_-][a-z_-]+/g;

const CURRENCY_CODE = 'CO' + 'P';
const ZONE = 'America/' + 'Bogota';
const LOCALE = 'es-' + 'CO';
const COUNTRY = 'colombi';
const CITY = 'Bogot';
const CALLING_CODE = String.raw`\+` + '57';

const FORBIDDEN = new RegExp(
  [
    String.raw`(?:(?<![\p{L}\p{N}_])|(?<=\\[sb]))${CURRENCY_CODE}(?![\p{L}\p{N}_])`,
    ZONE,
    `(?<![\\p{L}\\p{N}_-])${LOCALE}(?![\\p{L}\\p{N}_])`,
    `${CITY}[aá]`,
    `${CALLING_CODE}(?![0-9])`,
    `${CALLING_CODE}3[0-9]{9}(?![0-9])`,
  ].join('|'),
  'u',
);
const FORBIDDEN_COUNTRY = new RegExp(COUNTRY, 'iu');

export function namesColombianSample(line: string): boolean {
  const text = line.replace(APPLIED_MIGRATION_NAME, '');
  return FORBIDDEN.test(text) || FORBIDDEN_COUNTRY.test(text);
}

const BINARY = /\.(?:png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|xlsx)$/i;

function trackedTextFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((file) => file !== '' && !BINARY.test(file));
}

describe('los valores de ejemplo son de Venezuela y en USD, nunca de Colombia', () => {
  it('ningún fichero versionado fuera de las excepciones los nombra', () => {
    const files = trackedTextFiles();
    expect(files.length).toBeGreaterThan(1000);
    const hits = files
      .filter((file) => !EXCLUDED.some((rule) => rule.test(file)))
      .flatMap((file) =>
        readFileSync(join(REPO_ROOT, file), 'utf8')
          .split('\n')
          .flatMap((line, i) =>
            namesColombianSample(line)
              ? [`${file}:${i + 1}: ${line.trim().slice(0, 120)}`]
              : [],
          ),
      );
    expect(hits).toEqual([]);
  });

  it('cada excepción sigue haciendo falta', () => {
    const files = trackedTextFiles();
    for (const rule of EXCLUDED) {
      expect({
        rule: rule.source,
        used: files.some((file) => rule.test(file)),
      }).toEqual({ rule: rule.source, used: true });
    }
  });

  it('la guarda detecta cada término y deja pasar lo parecido', () => {
    for (const line of [
      `currency: '${CURRENCY_CODE}',`,
      `150.000 ${CURRENCY_CODE}`,
      String.raw`/150\.000,00\s${CURRENCY_CODE}/`,
      String.raw`/\b${CURRENCY_CODE}\b/`,
      `timeZone: '${ZONE}',`,
      `locale: '${LOCALE}',`,
      'Sede en ' + 'Colombia',
      'un paciente ' + 'colombiano',
      'COLOMBIA',
      `${CITY}á`,
      `${CITY}a`,
      `phone: '+${'57'} 300 123 4567',`,
      `phone: '+${'57'}3001234567',`,
    ]) {
      expect({ line, caught: namesColombianSample(line) }).toEqual({
        line,
        caught: true,
      });
    }
    for (const line of [
      `RATE_LIMIT_${CURRENCY_CODE}Y_LINK`,
      `${CURRENCY_CODE}YRIGHT`,
      `Y${CURRENCY_CODE}`,
      `es-${'CO'}L`,
      'currency: USD',
      "timeZone: 'America/Caracas'",
      '20261110130000_sin_' + 'colombia_identificadores',
      'test/sin-' + 'colombia-identifiers-migration.int-spec.ts',
    ]) {
      expect({ line, caught: namesColombianSample(line) }).toEqual({
        line,
        caught: false,
      });
    }
  });
});
