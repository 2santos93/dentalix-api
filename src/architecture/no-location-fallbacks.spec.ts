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
  // DX-324: el módulo de recetas entero, salvo los legados de R12, en
  // `prescriptions module reads no country` (abajo).
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
/**
 * R1/R12: los únicos ficheros de producción del módulo que nombran el país
 * legado, cada uno con la cabecera «Excepción G5.3 (DX-334)» por la que
 * G5.3 los encontrará. Cualquier otro que lo lea (una regla, el controlador,
 * la seguridad, las letras…) falla.
 */
const R12_HEADER = 'Excepción G5.3 (DX-334)';
const R12_COUNTRY_FILES = [
  'domain/legacy-prescription.ts',
  'domain/prescription-hash.ts',
  'domain/entities/prescription.entity.ts',
  'infrastructure/repositories/prisma-prescription.repository.ts',
  'presentation/dto/prescription.dto.ts',
  'presentation/prescription.presenter.ts',
].map((path) => join(PRESCRIPTIONS, ...path.split('/')));

describe('receta sin reglas nacionales (DX-324)', () => {
  it('architecture: prescriptions module names no national rule', () => {
    const files = tsFiles(PRESCRIPTIONS).filter(
      (file) => isProduction(file) && !LEGACY_PRESCRIPTION_FILES.includes(file),
    );
    expect(files.length).toBeGreaterThan(10);
    expect(offending(files, (line) => NATIONAL_RULE.test(line))).toEqual([]);
  });

  it('architecture: prescriptions module reads no country outside the R12 legacy files', () => {
    const files = tsFiles(PRESCRIPTIONS).filter(
      (file) => isProduction(file) && !R12_COUNTRY_FILES.includes(file),
    );
    expect(files.length).toBeGreaterThan(20);
    expect(offending(files, (line) => /country/i.test(line))).toEqual([]);
  });

  it('every R12 legacy file exists and carries the G5.3 header', () => {
    for (const file of R12_COUNTRY_FILES) {
      expect({
        file: relative(SRC, file),
        header: readFileSync(file, 'utf8').slice(0, 200).includes(R12_HEADER),
      }).toEqual({ file: relative(SRC, file), header: true });
    }
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

/**
 * DX-326 (spec §6.8, R8, R10, R11): los pagadores no tienen país y los códigos
 * de tipo anteriores a DX-326 viven solo en `legacy-payer-type.ts`. Los
 * literales de los controles se arman por partes: este fichero es una de las
 * excepciones de R10, pero su código de producción no los nombra.
 */
const PAYER_MODULES = [
  'payers',
  'agreements',
  'patient-agreements',
  'patient-coverages',
].map((name) => join(SRC, 'modules', name));
const LEGACY_PAYER_TYPE_FILE = join(
  SRC,
  'modules',
  'payers',
  'domain',
  'legacy-payer-type.ts',
);
const PAYER_REPOSITORIES = [
  'payers/infrastructure/repositories/prisma-payer.repository.ts',
  'agreements/infrastructure/repositories/prisma-agreement.repository.ts',
  'patient-agreements/infrastructure/repositories/prisma-patient-agreement.repository.ts',
  'patient-coverages/infrastructure/repositories/prisma-patient-coverage.repository.ts',
].map((path) => join(SRC, 'modules', ...path.split('/')));
const R10_HEADER =
  'Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326';
/** Los códigos antiguos en código (spec §6.8). */
const LEGACY_PAYER_CODE =
  /\b(MUTUA_ES|PREPAGADA_CO|EPS_CO)\b|['"](EMPRESA|OTRO)['"]|PayerType\.(EMPRESA|OTRO)/;
/** `OTRO` como tipo en prosa; «OTRO usuario» y «OTRO tenant» son la palabra. */
const LEGACY_PAYER_PROSE = /\bOTRO\b(?! usuario| tenant)/;
/** Un comentario (`//`, `*`) o una cadena `description:`/`summary:`. */
const isProseLine = (line: string): boolean =>
  /^\s*(\/\/|\/?\*)/.test(line) || /\b(description|summary)\s*:/.test(line);
const legacyPayerTypeHit = (line: string): boolean =>
  LEGACY_PAYER_CODE.test(line) ||
  (isProseLine(line) && LEGACY_PAYER_PROSE.test(line));
/** `PayerType` en un import de `@prisma/client` (también de varias líneas). */
const PRISMA_PAYER_IMPORT =
  /import\s+(?:type\s+)?\{[^}]*\bPayerType\b[^}]*\}\s*from\s*'@prisma\/client'/g;
/**
 * El enum guardado por su nombre: `$Enums.PayerType`, `$Enums['PayerType']`,
 * `const { PayerType } = $Enums` y los tipos `Prisma.Payer*`. Los demás enums
 * de `$Enums` siguen permitidos.
 */
const PRISMA_PAYER_ENUM =
  /\$Enums\s*(?:\.\s*PayerType\b|\[\s*['"]PayerType['"]\s*\])|\{[^}]*\bPayerType\b[^}]*\}\s*=\s*\$Enums\b|Prisma\.Payer\w*/;
/**
 * Una relación `payer`/`payers` anidada que trae el tipo guardado sin nombrar
 * el enum: `payer: true`, `payer: { include: … }` o un `select` con
 * `type: true` (sobre el fichero entero: Prettier lo parte en varias líneas).
 * Límites conocidos, sin guarda: un `select` que anida otro objeto antes de
 * `type` (`[^}]` corta en la primera llave), un `select` en una constante
 * aparte, `tx.payer.find*` sin `select` y el SQL crudo sobre `payers`. Esos
 * caminos los cubren la revisión y los tests de SEC-047/049.
 */
const NESTED_PAYER_TYPE =
  /\bpayers?\s*:\s*(?:true\b|\{\s*include\b|\{\s*select\s*:\s*\{[^}]*\btype\s*:\s*true\b)/g;

describe('pagadores sin país (DX-326)', () => {
  const payerProduction = PAYER_MODULES.flatMap((dir) => tsFiles(dir)).filter(
    isProduction,
  );

  it('architecture: payer modules read no country', () => {
    expect(payerProduction.length).toBeGreaterThan(20);
    expect(offending(payerProduction, (line) => /country/i.test(line))).toEqual(
      [],
    );
  });

  it('architecture: payer modules name no legacy payer type outside legacy-payer-type.ts', () => {
    const files = payerProduction.filter(
      (file) => file !== LEGACY_PAYER_TYPE_FILE,
    );
    expect(files.length).toBeGreaterThan(20);
    expect(offending(files, legacyPayerTypeHit)).toEqual([]);
  });

  it('architecture: only legacy-payer-type.ts and the four payer repositories name the stored payer enum', () => {
    const allowed = [LEGACY_PAYER_TYPE_FILE, ...PAYER_REPOSITORIES];
    expect(PAYER_REPOSITORIES).toHaveLength(4);
    const files = tsFiles(SRC).filter(
      (file) => isProduction(file) && !allowed.includes(file),
    );
    expect([
      ...offending(files, (line) => PRISMA_PAYER_ENUM.test(line)),
      ...offendingMatches(files, PRISMA_PAYER_IMPORT, () => true),
    ]).toEqual([]);
  });

  it('architecture: only the four payer repositories read the stored payer type through a nested relation', () => {
    const files = tsFiles(SRC).filter(
      (file) => isProduction(file) && !PAYER_REPOSITORIES.includes(file),
    );
    expect(offendingMatches(files, NESTED_PAYER_TYPE, () => true)).toEqual([]);
  });

  it('the nested payer relation pattern catches the stored type and skips other selects', () => {
    const hits = (code: string): number =>
      [...code.matchAll(NESTED_PAYER_TYPE)].length;
    expect(
      [
        'include: { payer: true }',
        'payer: { include: { agreements: true } }',
        'payer: {\n  select: { id: true, type: true },\n}',
        'payers: { select: { name: true, type: true } }',
      ].map(hits),
    ).toEqual([1, 1, 1, 1]);
    expect(
      [
        'payer: { select: { name: true } }',
        'select: { id: true, payer: { select: { name: true } } }',
        'payer: { id: family.payer.id, firstName: family.payer.firstName }',
        'payer: { ...payer, relationship: null }',
      ].map(hits),
    ).toEqual([0, 0, 0, 0]);
  });

  it('legacy-payer-type.ts carries the G5.3 header', () => {
    expect(
      readFileSync(LEGACY_PAYER_TYPE_FILE, 'utf8')
        .slice(0, 200)
        .includes(R10_HEADER),
    ).toBe(true);
  });

  it('the legacy payer type patterns catch each code and skip neutral text', () => {
    for (const line of [
      "const x = 'EPS" + "_CO';",
      'PayerType.' + 'OTRO',
      "type: 'EMPRE" + "SA',",
      'MUTUA' + '_ES',
      'PREPAGADA' + '_CO',
      '$Enums.PayerType',
      '// un pagador ' + 'OTRO',
      "description: 'Tipo OTRO del pagador'",
    ]) {
      expect({
        line,
        caught:
          legacyPayerTypeHit(line) ||
          PRISMA_PAYER_ENUM.test(line) ||
          [...line.matchAll(PRISMA_PAYER_IMPORT)].length > 0,
      }).toEqual({ line, caught: true });
    }
    expect(
      [
        "import {\n  PayerType,\n  Prisma,\n} from '@prisma/client';",
        "import type { PayerType } from '@prisma/client';",
      ].map((code) => [...code.matchAll(PRISMA_PAYER_IMPORT)].length),
    ).toEqual([1, 1]);
    expect([
      ..."import { Prisma } from '@prisma/client';".matchAll(
        PRISMA_PAYER_IMPORT,
      ),
    ]).toEqual([]);
    for (const line of [
      "$Enums['PayerType']",
      'const { PayerType } = $Enums;',
      'Prisma.PayerWhereInput',
    ]) {
      expect({ line, caught: PRISMA_PAYER_ENUM.test(line) }).toEqual({
        line,
        caught: true,
      });
    }
    for (const line of [
      '$Enums.ClinicRole',
      "import { $Enums } from '@prisma/client';",
      '$Enums.PayerTypeLike',
    ]) {
      expect({ line, caught: PRISMA_PAYER_ENUM.test(line) }).toEqual({
        line,
        caught: false,
      });
    }
    for (const line of [
      '// los registró ' + 'OTRO usuario',
      '// de ' + 'OTRO tenant',
      "type: 'OTHER',",
      "type: 'EMPLOYER',",
    ]) {
      expect({ line, caught: legacyPayerTypeHit(line) }).toEqual({
        line,
        caught: false,
      });
    }
  });
});

/**
 * DX-327 (spec §6.8, R1, R4, R5, R13, pre-flight M1): los tipos de documento
 * son genéricos. Los códigos anteriores y los nombres de un país viven solo en
 * `legacy-doc-type.ts`; el enum guardado lo nombran ese fichero y los tres
 * escritores de R5; hay un solo mapa de etiquetas y un solo resolvedor de
 * nombres. Además de la producción de `src`, se recorren la demo
 * (`prisma/demo/**`, datos y CSV), `prisma/seed*.ts` y `schema.prisma`. Los
 * literales de los controles se arman por partes.
 */
const ROOT = join(SRC, '..');
const PRISMA_DIR = join(ROOT, 'prisma');
const PATIENTS_DOMAIN = join(SRC, 'modules', 'patients', 'domain');
const LEGACY_DOC_TYPE_FILE = join(PATIENTS_DOMAIN, 'legacy-doc-type.ts');
const DOCUMENT_TYPE_FILE = join(PATIENTS_DOMAIN, 'document-type.ts');
const DOCUMENT_TYPE_NAME_FILES = [
  'patients/domain/document-type.ts',
  'patients/domain/document-type-names.ts',
  'patients/infrastructure/repositories/prisma-document-type-names.repository.ts',
].map((path) => join(SRC, 'modules', ...path.split('/')));
const DOC_TYPE_LEGACY_WRITERS = [
  'patients/infrastructure/repositories/prisma-patient.repository.ts',
  'patients/infrastructure/repositories/prisma-responsible-party.repository.ts',
  'patient-imports/infrastructure/prisma-patient-import.repository.ts',
].map((path) => join(SRC, 'modules', ...path.split('/')));
const R13_HEADER =
  'Excepción G5.3 (DX-334): tipos de documento anteriores a DX-327';

/** Todo fichero bajo `dir` (la demo trae CSV además de `.ts`). */
function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? allFiles(path) : [path];
  });
}

/** `prisma/demo/**` y `prisma/seed*.ts`. */
const demoFiles = (): string[] => [
  ...allFiles(join(PRISMA_DIR, 'demo')),
  ...readdirSync(PRISMA_DIR)
    .filter((name) => /^seed.*\.ts$/.test(name))
    .map((name) => join(PRISMA_DIR, name)),
];

const AUTHORITY = 'INVI' + 'MA|marcado ' + 'CE';
/** Un código anterior como tipo, el enum por su valor o un nombre de un país. */
const LEGACY_DOC_TYPE = new RegExp(
  '[\'"`](CC|TI|CE)[\'"`]|DocType\\.(CC|TI|CE)\\b|[Cc]édula|[Tt]arjeta de identidad|[Ee]xtranjería|' +
    AUTHORITY,
);
/** `DocType` en un import de `@prisma/client` (también de varias líneas). */
const PRISMA_DOC_TYPE_IMPORT =
  /import\s+(?:type\s+)?\{[^}]*\bDocType\b[^}]*\}\s*from\s*'@prisma\/client'/g;
/** El enum guardado por su nombre en `$Enums`. */
const PRISMA_DOC_TYPE_ENUM =
  /\$Enums\s*(?:\.\s*DocType\b|\[\s*['"]DocType['"]\s*\])|\{[^}]*\bDocType\b[^}]*\}\s*=\s*\$Enums\b/;
/** La columna antigua en SQL crudo (R4). */
const LEGACY_DOC_TYPE_COLUMN = /"docType"/;
const DOC_TYPE_LABEL_MAP =
  /\b(?:const|let)\s+DOC_TYPE_LABELS?\b|PASSPORT:\s*'Pasaporte'/;
/** La demo: además, el enum por su nombre y una línea CSV con un código. */
const DEMO_COUNTRY_DOCUMENT = new RegExp(
  '[Cc][ée]dula|[Tt]arjeta de identidad|[Ee]xtranjer[ií]a|' +
    AUTHORITY +
    '|DocType\\.|^(?:CC|TI|CE);',
);
/**
 * Un nombre largo de documento (spec §6.8). Sobre el código sin comentarios:
 * la cabecera G5.3 y la prosa llevan tildes. Las claves de sinónimo
 * normalizadas (`tarjetadeidentidad`) no lo cumplen: van sin tildes ni
 * espacios, y las comprueba `isLegacyKeyLiteral`.
 */
const LONG_DOCUMENT_NAME =
  /[Cc][ée]dula de|[Tt]arjeta de|[Ee]xtranjería|[ÁÉÍÓÚáéíóú]/;
/** Literal de `legacy-doc-type.ts`: un código (`CC`, `PASSPORT`) o una clave normalizada. */
const isLegacyKeyLiteral = (literal: string): boolean =>
  /^(?:[A-Z_]+|[a-z0-9]+)$/.test(literal);
/** Una línea que traduce un código y nombra la etiqueta a la vez. */
const LEGACY_TRANSLATION =
  /\b(?:docTypeFromCode|docTypeFromStored|resolveDocTypeInput)\s*\(|\bLEGACY_DOC_TYPES\b/;
const DOC_TYPE_NAME_RESOLUTION =
  /DOC_TYPE_LABEL\[|docTypeName(?:NationalId|Passport|ResidencePermit|TaxId|Other)\b/;
/** Un alta de paciente o responsable por Prisma (pre-flight M1). */
const PATIENT_CREATE =
  /\b(?:patient|patientResponsibleParty)\.(?:create|createMany)\s*\(/g;

/** Línea sin su comentario (`//`, `/*`, ` *`); para `legacy-doc-type.ts`. */
const codeOnly = (line: string): string =>
  /^\s*(\/\/|\/?\*)/.test(line) ? '' : line.replace(/\s\/\/.*$/, '');

/** El argumento de la llamada que abre en `start` (paréntesis equilibrados). */
function callArgument(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return text.slice(start + 1);
}

/** Un alta con `documentType` y sin `docType`: el hueco OTHER (spec §3.3). */
const writesDocumentTypeAlone = (argument: string): boolean =>
  /\bdocumentType\b/.test(argument) && !/\bdocType\b/.test(argument);

/** `fichero:línea` de cada alta de paciente o responsable sin la pareja de R5. */
function patientCreatesWithoutLegacyPair(files: string[]): string[] {
  return files.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(PATIENT_CREATE)].flatMap((match) => {
      const open = match.index + match[0].length - 1;
      const line = text.slice(0, match.index).split('\n').length;
      return writesDocumentTypeAlone(callArgument(text, open))
        ? [`${relative(SRC, file)}:${line}`]
        : [];
    });
  });
}

describe('tipos de documento genéricos (DX-327)', () => {
  const production = tsFiles(SRC).filter(isProduction);

  it('architecture: no legacy document type or name outside legacy-doc-type.ts', () => {
    const files = [
      ...production.filter((file) => file !== LEGACY_DOC_TYPE_FILE),
      ...demoFiles(),
      join(PRISMA_DIR, 'schema.prisma'),
    ];
    expect(files.length).toBeGreaterThan(500);
    expect(offending(files, (line) => LEGACY_DOC_TYPE.test(line))).toEqual([]);
  });

  it('architecture: only legacy-doc-type.ts and the three insert writers name the stored legacy enum', () => {
    expect(DOC_TYPE_LEGACY_WRITERS).toHaveLength(3);
    const allowed = [LEGACY_DOC_TYPE_FILE, ...DOC_TYPE_LEGACY_WRITERS];
    const files = production.filter((file) => !allowed.includes(file));
    expect([
      ...offending(files, (line) => PRISMA_DOC_TYPE_ENUM.test(line)),
      ...offendingMatches(files, PRISMA_DOC_TYPE_IMPORT, () => true),
    ]).toEqual([]);
  });

  it('architecture: no raw SQL names the legacy docType column', () => {
    expect(
      offending(production, (line) => LEGACY_DOC_TYPE_COLUMN.test(line)),
    ).toEqual([]);
  });

  it('architecture: one document label map', () => {
    const hits = offending(production, (line) => DOC_TYPE_LABEL_MAP.test(line));
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.filter(
        (hit) => !hit.startsWith(relative(SRC, DOCUMENT_TYPE_FILE) + ':'),
      ),
    ).toEqual([]);
  });

  it('legacy-doc-type.ts carries the G5.3 header', () => {
    expect(
      readFileSync(LEGACY_DOC_TYPE_FILE, 'utf8')
        .slice(0, 200)
        .includes(R13_HEADER),
    ).toBe(true);
  });

  it('architecture: the demo names no country document or authority', () => {
    const files = demoFiles();
    expect(files.some((file) => file.endsWith('.csv'))).toBe(true);
    expect(
      offending(files, (line) => DEMO_COUNTRY_DOCUMENT.test(line)),
    ).toEqual([]);
  });

  it('architecture: no code derives a document label from a legacy code', () => {
    const legacyCode = readFileSync(LEGACY_DOC_TYPE_FILE, 'utf8')
      .split('\n')
      .map(codeOnly);
    expect(
      legacyCode.flatMap((line, i) =>
        LONG_DOCUMENT_NAME.test(line) ? [`legacy-doc-type.ts:${i + 1}`] : [],
      ),
    ).toEqual([]);
    const literals = legacyCode
      .filter((line) => !/^\s*import\b|\bfrom\s+'/.test(line))
      .flatMap((line) => [...line.matchAll(/'([^']*)'/g)].map((m) => m[1]));
    expect(literals.length).toBeGreaterThan(30);
    expect(literals.filter((literal) => !isLegacyKeyLiteral(literal))).toEqual(
      [],
    );
    expect(
      offending(
        production,
        (line) =>
          line.includes('docTypeLabel') && LEGACY_TRANSLATION.test(line),
      ),
    ).toEqual([]);
  });

  it('tests never create a patient with documentType and no docType', () => {
    const files = [
      ...tsFiles(join(ROOT, 'test')),
      ...tsFiles(SRC).filter((file) => file.endsWith('.spec.ts')),
    ];
    expect(files.length).toBeGreaterThan(300);
    const creates = files.flatMap((file) => [
      ...readFileSync(file, 'utf8').matchAll(PATIENT_CREATE),
    ]);
    expect(creates.length).toBeGreaterThan(100);
    expect(patientCreatesWithoutLegacyPair(files)).toEqual([]);
  });

  it('architecture: one document type name resolver', () => {
    const files = production.filter(
      (file) => !DOCUMENT_TYPE_NAME_FILES.includes(file),
    );
    expect(
      offending(files, (line) => DOC_TYPE_NAME_RESOLUTION.test(line)),
    ).toEqual([]);
  });

  it('the document type patterns catch each legacy form and skip neutral text', () => {
    const caught = (line: string): boolean =>
      LEGACY_DOC_TYPE.test(line) ||
      LEGACY_DOC_TYPE_COLUMN.test(line) ||
      PRISMA_DOC_TYPE_ENUM.test(line) ||
      [...line.matchAll(PRISMA_DOC_TYPE_IMPORT)].length > 0;
    for (const line of [
      "docType: 'C" + "C',",
      'DocType.' + 'TI',
      'C\u00e9dula de ciudadan\u00eda',
      'con marcado ' + 'CE',
      'INVI' + 'MA 2019',
      'Tarjeta' + ' de identidad',
      'SELECT p."doc' + 'Type" FROM patients p',
      'import { Doc' + "Type } from '@prisma/client';",
      'import {\n  Doc' + 'Type,\n  Prisma,\n} from ' + "'@prisma/client';",
      '$Enums.Doc' + 'Type',
    ]) {
      expect({ line, caught: caught(line) }).toEqual({ line, caught: true });
    }
    for (const line of [
      "docType: 'NATIONAL_ID',",
      'docType: dto.docType,',
      "enumName: 'DocType',",
      "import { DocumentType } from '@prisma/client';",
      "import type { LegacyDocType } from './legacy-doc-type';",
      'Documento nacional 123',
    ]) {
      expect({ line, caught: caught(line) }).toEqual({ line, caught: false });
    }
    expect(DEMO_COUNTRY_DOCUMENT.test('C' + 'C;123;Ana')).toBe(true);
    expect(DEMO_COUNTRY_DOCUMENT.test('INVI' + 'MA 2019DM-0019876')).toBe(true);
    expect(DEMO_COUNTRY_DOCUMENT.test('Documento nacional;DEMO-I001')).toBe(
      false,
    );
    expect(LONG_DOCUMENT_NAME.test('Tarjeta' + ' de identidad')).toBe(true);
    expect(LONG_DOCUMENT_NAME.test('Extranjer\u00eda')).toBe(true);
    expect(isLegacyKeyLiteral('tarjetade' + 'identidad')).toBe(true);
    expect(isLegacyKeyLiteral('Tarjeta de ' + 'identidad')).toBe(false);
    expect(
      LEGACY_TRANSLATION.test('docTypeLabel: docTypeFromCode(row.docType)'),
    ).toBe(true);
    expect(DOC_TYPE_NAME_RESOLUTION.test('DOC_TYPE_LABEL[type]')).toBe(true);
    expect(DOC_TYPE_NAME_RESOLUTION.test('DOC_TYPE_LABEL_MAX')).toBe(false);
    const create = 'raw.patient' + '.create';
    expect(
      writesDocumentTypeAlone(
        callArgument(
          `${create}({ data: { documentType: 'OTHER', docNumber: '1' } })`,
          create.length,
        ),
      ),
    ).toBe(true);
    expect(
      writesDocumentTypeAlone(
        callArgument(
          `${create}({ data: { documentType: 'OTHER', docType: legacyStoredDocType('OTHER') } })`,
          create.length,
        ),
      ),
    ).toBe(false);
  });
});
