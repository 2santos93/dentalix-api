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

/**
 * `fichero:línea` de cada coincidencia de `pattern` (con `g`) sobre el fichero
 * entero, no línea a línea: una llamada partida en varias líneas por Prettier
 * (`new Intl.NumberFormat(\n  'es',`) también cuenta. `accept` recibe la
 * coincidencia y la línea donde empieza.
 */
function offendingMatches(
  files: string[],
  pattern: RegExp,
  accept: (match: RegExpExecArray, line: string) => boolean,
): string[] {
  return files.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    return [...text.matchAll(pattern)].flatMap((match) => {
      const lineIndex = text.slice(0, match.index).split('\n').length - 1;
      return accept(match, lines[lineIndex])
        ? [`${relative(SRC, file)}:${lineIndex + 1}`]
        : [];
    });
  });
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
/**
 * Un locale literal pasado a `Intl.*(` o `toLocale*String(`, también en un array y
 * aunque la llamada ocupe varias líneas: con región (`'es-CO'`), región
 * numérica (`'es-419'`), escritura (`'zh-Hant-TW'`) o solo el idioma (`'es'`,
 * la forma del `formatMoney` retirado). Solo en el contexto de la llamada, para
 * no confundir un texto cualquiera en español con un locale.
 * `toLocaleLowerCase('es')` (claves de comparación) no formatea: no entra.
 */
const LOCALE_CALL =
  /(?:Intl\.[A-Za-z]+\(|\.toLocale[A-Za-z]*String\()\s*\[?\s*'([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)'/g;
/** Un reloj fijo: `hourCycle: 'h23'`, o `hour12:` (que manda sobre `hourCycle`, §5.1). */
const HOUR_CYCLE_LITERAL = /hourCycle:\s*'h\d{2}'|\bhour12\s*:/;
/** Donde se arma el texto del recordatorio y el helper: sin país. */
const COUNTRY_FREE = [
  join(SRC, 'modules', 'reminders', 'domain', 'starts-at-label.ts'),
  join(
    SRC,
    'modules',
    'reminders',
    'domain',
    'ports',
    'reminder-repository.port.ts',
  ),
  join(
    SRC,
    'modules',
    'patients',
    'domain',
    'communication',
    'notice-recipient.ts',
  ),
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

  it('architecture: locale literals only in the neutral allowlist', () => {
    const neutral = (file: string) => NEUTRAL_FORMATTERS.includes(file);
    const localeLiteral =
      (allowed: string[]) => (match: RegExpExecArray, line: string) =>
        !line.includes('example:') && !allowed.includes(match[1]);
    expect([
      ...offendingMatches(
        production.filter((file) => !neutral(file)),
        LOCALE_CALL,
        localeLiteral([]),
      ),
      ...offendingMatches(
        production.filter(neutral),
        LOCALE_CALL,
        localeLiteral(NEUTRAL_LOCALES),
      ),
    ]).toEqual([]);
  });

  it('the locale pattern catches every literal shape and skips plain Spanish text', () => {
    const caught = (code: string) =>
      [...code.matchAll(LOCALE_CALL)].map((match) => match[1]);
    expect(
      caught(
        [
          "new Intl.NumberFormat('es', { style: 'currency' })",
          "new Intl.DateTimeFormat(['es-CO'])",
          "Intl.NumberFormat('es-419')",
          "new Intl.DateTimeFormat('zh-Hant-TW', {})",
          "amount.toLocaleString('es')",
          "day.toLocaleDateString(\n  'de-DE',\n)",
          "new Intl.NumberFormat(\n  'fr',\n  { minimumFractionDigits: 2 },\n)",
        ].join('\n'),
      ),
    ).toEqual(['es', 'es-CO', 'es-419', 'zh-Hant-TW', 'es', 'de-DE', 'fr']);
    expect(
      caught(
        [
          "throw new BadRequestException('es obligatorio')",
          "const label = 'de la sede';",
          "message: 'en la sede no hay caja abierta'",
          "a.name.localeCompare(b.name, 'es')",
          "label.toLocaleLowerCase('es')",
        ].join('\n'),
      ),
    ).toEqual([]);
    expect(HOUR_CYCLE_LITERAL.test('{ hour12: true }')).toBe(true);
    expect(HOUR_CYCLE_LITERAL.test("{ hourCycle: 'h12' }")).toBe(true);
    expect(HOUR_CYCLE_LITERAL.test('{ hourCycle: fmt.hourCycle }')).toBe(false);
  });

  it('architecture: no hourCycle literal nor hour12 outside the helper and the allowlist', () => {
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
    expect(
      offending([...COUNTRY_FREE, ...formatFiles], (line) =>
        /country/i.test(line),
      ),
    ).toEqual([]);
  });
});
