import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * GLOBAL-G1 (spec §9, R5): ningún código deriva la zona de una sede del país
 * ni la sustituye por una de reserva. Dos pasadas sobre `src/`:
 *  (a) código de producción (sin `*.spec.ts` ni `__fixtures__/`): ningún
 *      `'America/Bogota'` salvo en los `example:` de OpenAPI;
 *  (b) todo `src/`, sin exclusiones: ningún nombre de los fallbacks retirados.
 * G1-B (spec §14, pre-flight I5) añade tres más, al final.
 * Los literales se arman por partes para que este fichero no se delate solo.
 */
const SRC = join(__dirname, '..');
const BOGOTA = `'America/${'Bogota'}'`;
const IANA_ZONE_NAMES_FILE = join(SRC, 'shared', 'time', 'iana-zone-names.ts');
const RETIRED = new RegExp(
  [
    'timeZoneFor' + 'Country',
    'DEFAULT_BUSINESS_HOURS_' + 'TIMEZONE',
    'FALLBACK_' + 'TIME_ZONE',
    'requireConfigured' + 'LocationTimeZone',
  ].join('|'),
);

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** `fichero:línea` de cada línea que cumple `matches`. */
function offending(
  files: string[],
  matches: (line: string) => boolean,
): string[] {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        matches(line) ? [`${relative(SRC, file)}:${i + 1}`] : [],
      ),
  );
}

/** Código de producción: sin `*.spec.ts` ni `__fixtures__/`. */
const isProduction = (file: string): boolean =>
  !file.endsWith('.spec.ts') && !file.split(sep).includes('__fixtures__');

describe('sin zona por defecto ni derivada del país (G1, R5)', () => {
  const files = tsFiles(SRC);

  it('(a) production code has no America/Bogota outside OpenAPI examples', () => {
    const production = files.filter(
      (file) =>
        isProduction(file) &&
        // Lista generada de todas las zonas IANA: referencia, no un fallback.
        file !== IANA_ZONE_NAMES_FILE,
    );
    expect(
      offending(
        production,
        (line) => line.includes(BOGOTA) && !line.includes('example:'),
      ),
    ).toEqual([]);
  });

  it('(b) src has none of the retired zone fallbacks', () => {
    expect(offending(files, (line) => RETIRED.test(line))).toEqual([]);
  });
});

/**
 * G1-B (spec §14, R2/R4, pre-flight I5): formato regional y reloj solo desde
 * el helper (`shared/format/`). Lista EXPLÍCITA de formatters neutros que se
 * quedan: sacan partes numéricas para lógica (claves `YYYY-MM-DD`, minutos),
 * nunca texto para una persona, y solo con `'en-US'`/`'en-CA'`.
 */
const FORMAT_DIR = join(SRC, 'shared', 'format') + sep;
const NEUTRAL_FORMATTERS = [
  'shared/time/civil-day.ts',
  'modules/location-schedule/application/business-hours.ts',
  'modules/periodontal/application/use-cases/perio-exams.use-cases.ts',
  'modules/prescriptions/application/use-cases/prescriptions.use-cases.ts',
  'modules/treatment-plans/application/use-cases/plan-quote.use-cases.ts',
].map((path) => join(SRC, ...path.split('/')));
const NEUTRAL_LOCALES = ['en-US', 'en-CA'];
/** Un locale regional literal pasado a `Intl.*(` o `toLocale*String(`. */
const REGIONAL_LOCALE_CALL =
  /(?:Intl\.[A-Za-z]+\(|toLocale[A-Za-z]*String\()\s*'([a-z]{2}-[A-Z]{2})'/;
const HOUR_CYCLE_LITERAL = /hourCycle:\s*'h\d{2}'/;
/** Donde se arma el texto del recordatorio y el helper: sin país. */
const COUNTRY_FREE = [
  join(SRC, 'modules', 'reminders', 'domain', 'starts-at-label.ts'),
];

describe('formato regional y reloj solo desde el helper (G1-B, I5)', () => {
  const files = tsFiles(SRC);
  const production = files.filter(
    (file) => isProduction(file) && !file.startsWith(FORMAT_DIR),
  );

  it('the neutral allowlist names files that exist', () => {
    const known = new Set(files);
    expect(NEUTRAL_FORMATTERS.filter((file) => !known.has(file))).toEqual([]);
  });

  it('architecture: regional locale literals only in the neutral allowlist', () => {
    const neutral = (file: string) => NEUTRAL_FORMATTERS.includes(file);
    const regionalLocale = (allowed: string[]) => (line: string) => {
      const match = REGIONAL_LOCALE_CALL.exec(line);
      return (
        match !== null &&
        !line.includes('example:') &&
        !allowed.includes(match[1])
      );
    };
    expect([
      ...offending(
        production.filter((file) => !neutral(file)),
        regionalLocale([]),
      ),
      ...offending(production.filter(neutral), regionalLocale(NEUTRAL_LOCALES)),
    ]).toEqual([]);
  });

  it('architecture: no hourCycle literal outside the helper and the allowlist', () => {
    expect(
      offending(
        production.filter((file) => !NEUTRAL_FORMATTERS.includes(file)),
        (line) => HOUR_CYCLE_LITERAL.test(line),
      ),
    ).toEqual([]);
  });

  it('architecture: reminder text builder has no country', () => {
    const formatFiles = files.filter((file) => file.startsWith(FORMAT_DIR));
    expect(formatFiles.length).toBeGreaterThan(0);
    // Los ports de `reminders/domain/ports/*` conservan `locationCountry`
    // para la regla de menores (DX-203): no entran aquí.
    expect(
      offending([...COUNTRY_FREE, ...formatFiles], (line) =>
        /country/i.test(line),
      ),
    ).toEqual([]);
  });
});
