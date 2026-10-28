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
/**
 * Donde se arma el texto del recordatorio y el helper, y de donde sale la
 * mayoría de edad de la clínica (DX-328): sin país.
 */
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
  join(
    SRC,
    'modules',
    'patients',
    'domain',
    'responsible-parties',
    'majority-age.ts',
  ),
  join(
    SRC,
    'modules',
    'patients',
    'infrastructure',
    'notices',
    'notice-context.ts',
  ),
  join(SRC, 'shared', 'time', 'business-days.ts'),
  // DX-316: el calendario de la sede y su cargador (I4).
  join(SRC, 'shared', 'locations', 'location-business-calendar.ts'),
  ...tsFiles(join(SRC, 'modules', 'location-calendar')).filter(isProduction),
  // DX-324: la receta única no se razona por país (spec R1).
  ...[
    'prescription-rules.ts',
    'prescription-settings.ts',
    'patient-snapshot.ts',
  ].map((file) => join(SRC, 'modules', 'prescriptions', 'domain', file)),
  join(
    SRC,
    'modules',
    'prescriptions',
    'application',
    'use-cases',
    'prescriptions.use-cases.ts',
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

  it('DX-316: every production file of the location calendar is in the country-free list', () => {
    const calendar = join(SRC, 'modules', 'location-calendar');
    for (const layer of [
      'domain',
      'application',
      'infrastructure',
      'presentation',
    ]) {
      expect({
        layer,
        listed: COUNTRY_FREE.some((file) =>
          file.startsWith(join(calendar, layer)),
        ),
      }).toEqual({ layer, listed: true });
    }
    expect(COUNTRY_FREE.filter((file) => file.endsWith('.spec.ts'))).toEqual(
      [],
    );
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

/**
 * DX-324 (spec §6.10, R12, R14): el módulo de recetas no nombra una regla
 * nacional, en mayúsculas o minúsculas. Fuera queda solo el tipo legado con
 * nombre (R12). El hash, la entidad, el repositorio y el DTO legados sí se
 * escanean: R12 les deja nombrar el país, no una regla nacional.
 */
const NATIONAL_RULE = new RegExp(
  [
    'colegiado',
    'DNI\\/NIE',
    'AEMPS',
    'CIMA',
    'Decreto',
    'Dec\\. 780',
    'RD 1718',
    'Espa' + 'ña',
    'Colom' + 'bia',
  ].join('|'),
  'i',
);
const PRESCRIPTIONS = join(SRC, 'modules', 'prescriptions');
const LEGACY_PRESCRIPTION_FILES = [
  join(PRESCRIPTIONS, 'domain', 'legacy-prescription.ts'),
];

describe('receta sin reglas nacionales (DX-324)', () => {
  it('architecture: prescriptions module names no national rule', () => {
    const files = tsFiles(PRESCRIPTIONS).filter(
      (file) => isProduction(file) && !LEGACY_PRESCRIPTION_FILES.includes(file),
    );
    expect(files.length).toBeGreaterThan(10);
    expect(offending(files, (line) => NATIONAL_RULE.test(line))).toEqual([]);
  });

  it('architecture: staff profile fields name no national rule', () => {
    const staff = join(SRC, 'modules', 'staff');
    const files = [
      join(staff, 'presentation', 'dto', 'update-staff.dto.ts'),
      join(staff, 'presentation', 'dto', 'staff-member.dto.ts'),
      join(staff, 'domain', 'entities', 'staff-member.entity.ts'),
    ];
    expect(
      offending(
        files,
        (line) => NATIONAL_RULE.test(line) || /RETHUS/i.test(line),
      ),
    ).toEqual([]);
  });

  it('the national-rule pattern catches each term and skips neutral text', () => {
    for (const line of [
      "'Falta tu número de colegiado'",
      "'Falta el DNI/NIE del paciente'",
      '// ficha técnica de la AEMPS',
      'cimaTechnicalSheetUrl: CIMA',
      ' * Decreto 780',
      ' * (Dec. 780/2016)',
      ' * RD 1718/2010',
      "'En " + 'Espa' + "ña cada receta'",
      "'Las sedes son de " + 'Colom' + "bia'",
      "'falta el dni/nie'",
      "'clínicas de " + 'colom' + "bia'",
      "'número de COLEGIADO'",
    ]) {
      expect({ line, caught: NATIONAL_RULE.test(line) }).toEqual({
        line,
        caught: true,
      });
    }
    for (const line of [
      "'Falta tu número de registro profesional'",
      "'Falta el número de historia clínica'",
      'const decree = 1;',
    ]) {
      expect({ line, caught: NATIONAL_RULE.test(line) }).toEqual({
        line,
        caught: false,
      });
    }
  });
});
