import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

/**
 * DX-334 (G5.3): Dentalix es un producto mundial y ninguna regla del código
 * de producción puede suponer un país. Esta guarda recorre `src/` (código,
 * comentarios y JSON, sin pruebas ni fixtures) y falla si una línea nombra
 * alguno de los términos de país del criterio de cierre de DX-311. Lo que sea
 * un dato legítimo (un catálogo mundial, un puente de compatibilidad) se
 * declara en `country-assumptions.exceptions.json`, por fichero y término,
 * con el motivo por escrito; una excepción que ya no hace falta también falla.
 * Los términos se arman por partes para que este fichero no se delate solo.
 * La lista de términos es idéntica en la guarda de la web.
 */
const SRC = join(__dirname, '..');
const EXCEPTIONS_FILE = join(__dirname, 'country-assumptions.exceptions.json');
const SELF = relative(SRC, __filename).split(sep).join('/');
const SELF_EXCEPTIONS = relative(SRC, EXCEPTIONS_FILE).split(sep).join('/');

/** Límites Unicode: una sigla pegada a otra letra, cifra o `_` no cuenta. */
const B = String.raw`(?<![\p{L}\p{N}_])`;
const E = String.raw`(?![\p{L}\p{N}_])`;

export interface CountryTerm {
  /** Id estable: es lo que citan las excepciones. */
  readonly id: string;
  readonly pattern: RegExp;
}

// Misma lista que la guarda de la web.
export const COUNTRY_TERMS: readonly CountryTerm[] = [
  {
    id: 'Clinic' + 'Country',
    pattern: new RegExp(`${B}Clinic` + `Country${E}`, 'u'),
  },
  {
    id: 'America/' + 'Bogota',
    pattern: new RegExp(`${B}America/` + `Bogota${E}`, 'u'),
  },
  // El lookbehind también excluye `-`: `de-es-CO` mal formado no cuenta.
  {
    id: 'es-' + 'CO',
    pattern: new RegExp(String.raw`(?<![\p{L}\p{N}_-])es-` + `CO${E}`, 'u'),
  },
  // Solo el literal entre comillas: `COPA` o `COPYRIGHT` no cuentan.
  {
    id: 'CO' + 'P',
    pattern: new RegExp(String.raw`['"\x60]CO` + String.raw`P['"\x60]`, 'u'),
  },
  { id: 'RE' + 'PS', pattern: new RegExp(`${B}RE` + `PS${E}`, 'u') },
  { id: 'CU' + 'PS', pattern: new RegExp(`${B}CU` + `PS${E}`, 'u') },
  { id: 'RI' + 'PS', pattern: new RegExp(`${B}RI` + `PS${E}`, 'u') },
  { id: 'RD' + 'A', pattern: new RegExp(`${B}RD` + `A${E}`, 'u') },
  { id: 'EPS_' + 'CO', pattern: new RegExp(`${B}EPS_` + `CO${E}`, 'u') },
  { id: 'MUTUA_' + 'ES', pattern: new RegExp(`${B}MUTUA_` + `ES${E}`, 'u') },
  {
    id: 'PREPAGADA_' + 'CO',
    pattern: new RegExp(`${B}PREPAGADA_` + `CO${E}`, 'u'),
  },
  // `\s` Unicode cubre el espacio duro y el salto dentro de un texto JSX.
  {
    id: 'Ley\\s+' + '1581',
    pattern: new RegExp(`${B}Ley\\s+` + `1581${E}`, 'u'),
  },
  {
    id: 'Decreto\\s+' + '1377',
    pattern: new RegExp(`${B}Decreto\\s+` + `1377${E}`, 'u'),
  },
  {
    id: 'Res\\.\\s*' + '839',
    pattern: new RegExp(`${B}Res\\.\\s*` + `839${E}`, 'u'),
  },
  {
    id: 'Res\\.\\s*' + '1995',
    pattern: new RegExp(`${B}Res\\.\\s*` + `1995${E}`, 'u'),
  },
  {
    id: 'C[eé]dula de ' + 'ciudadan[ií]a',
    pattern: new RegExp(`${B}C[eé]dula de ` + `ciudadan[ií]a${E}`, 'iu'),
  },
];

export interface CountryException {
  path: string;
  term: string;
  reason: string;
  removeWhen?: string;
}

export interface Finding {
  path: string;
  line: number;
  term: string;
  text: string;
}

const SCANNED = /\.(ts|tsx|js|mjs|json)$/;
const NOT_PRODUCTION = [
  /\.spec\.ts$/,
  /\.test\.tsx?$/,
  /(^|\/)__fixtures__\//,
  /(^|\/)lib\/test\//,
  /fixture/i,
  /(^|\/)lib\/api\/schema\.d\.ts$/,
];

/** Ficheros de producción que recorre la guarda, relativos a `root` con `/`. */
export function scannedFiles(root: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });
  return walk(root)
    .map((path) => relative(root, path).split(sep).join('/'))
    .filter(
      (path) =>
        SCANNED.test(path) &&
        path !== SELF &&
        path !== SELF_EXCEPTIONS &&
        !NOT_PRODUCTION.some((pattern) => pattern.test(path)),
    );
}

/** Ids de los términos que aparecen en una línea. */
export function termsInLine(line: string): string[] {
  return COUNTRY_TERMS.filter((term) => term.pattern.test(line)).map(
    (t) => t.id,
  );
}

/** Hallazgos de `root` que no cubre ninguna excepción. */
export function scanCountryAssumptions(
  root: string,
  exceptions: readonly CountryException[],
): Finding[] {
  const allowed = new Set(exceptions.map((e) => `${e.path}|${e.term}`));
  return scannedFiles(root).flatMap((path) =>
    readFileSync(join(root, path), 'utf8')
      .split('\n')
      .flatMap((text, i) =>
        termsInLine(text)
          .filter((term) => !allowed.has(`${path}|${term}`))
          .map((term) => ({ path, line: i + 1, term, text: text.trim() })),
      ),
  );
}

/** Problemas de forma y excepciones obsoletas; cada mensaje dice qué quitar. */
export function exceptionProblems(
  root: string,
  exceptions: readonly CountryException[],
): string[] {
  const ids = new Set(COUNTRY_TERMS.map((t) => t.id));
  const files = new Set(scannedFiles(root));
  const seen = new Set<string>();
  return exceptions.flatMap((e) => {
    const where = `${e.path} · ${e.term}`;
    if (!ids.has(e.term))
      return [`${where}: término desconocido; usa un id de COUNTRY_TERMS.`];
    if (typeof e.reason !== 'string' || e.reason.trim().length < 20) {
      return [`${where}: falta el motivo (reason, 20 caracteres o más).`];
    }
    if (seen.has(`${e.path}|${e.term}`))
      return [`${where}: excepción duplicada; quita una.`];
    seen.add(`${e.path}|${e.term}`);
    if (!existsSync(join(root, e.path))) {
      return [`${where}: el fichero ya no existe; quita la excepción.`];
    }
    if (!files.has(e.path)) {
      return [
        `${where}: el fichero no entra en el recorrido; quita la excepción.`,
      ];
    }
    const term = COUNTRY_TERMS.find((t) => t.id === e.term)!;
    const has = readFileSync(join(root, e.path), 'utf8')
      .split('\n')
      .some((line) => term.pattern.test(line));
    return has
      ? []
      : [`${where}: el fichero ya no contiene el término; quita la excepción.`];
  });
}

const REAL_EXCEPTIONS = JSON.parse(
  readFileSync(EXCEPTIONS_FILE, 'utf8'),
) as CountryException[];

/** Mensaje de fallo: lista los hallazgos y explica cómo declarar una excepción. */
function report(findings: Finding[]): string {
  return (
    findings
      .map((f) => `${f.path}:${f.line} · ${f.term}  ${f.text}`)
      .join('\n') +
    '\nSi es un dato legítimo (catálogo mundial o puente de compatibilidad), añade ' +
    '{ path, term, reason } a src/architecture/country-assumptions.exceptions.json ' +
    'con el motivo por escrito; si es una suposición de país, quítala.'
  );
}

function fakeSrc(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'country-assumptions-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

describe('sin suposiciones de país en src/ (DX-334)', () => {
  it('hoy: ninguna línea de producción nombra un término de país sin excepción', () => {
    const findings = scanCountryAssumptions(SRC, REAL_EXCEPTIONS);
    if (findings.length > 0) throw new Error(report(findings));
    expect(findings).toEqual([]);
  });

  it('las excepciones reales son válidas y siguen haciendo falta', () => {
    expect(exceptionProblems(SRC, REAL_EXCEPTIONS)).toEqual([]);
  });

  it('el recorrido cubre el código de producción y no a la propia guarda', () => {
    const files = scannedFiles(SRC);
    expect(files.length).toBeGreaterThan(300);
    expect(files).not.toContain(SELF);
    expect(files).not.toContain(SELF_EXCEPTIONS);
    expect(files.some((p) => /\.spec\.ts$/.test(p))).toBe(false);
  });

  it('detecta cada término y deja pasar lo parecido', () => {
    const samples: Record<string, string> = {
      ['Clinic' + 'Country']: 'type Clinic' + 'Country = string',
      ['America/' + 'Bogota']: "tz: 'America/" + "Bogota'",
      ['es-' + 'CO']: "locale: 'es-" + "CO'",
      ['CO' + 'P']: "currency: 'CO" + "P'",
      ['RE' + 'PS']: 'código RE' + 'PS',
      ['CU' + 'PS']: 'código CU' + 'PS',
      ['RI' + 'PS']: 'informe RI' + 'PS',
      ['RD' + 'A']: 'campo RD' + 'A',
      ['EPS_' + 'CO']: 'kind: EPS_' + 'CO',
      ['MUTUA_' + 'ES']: 'kind: MUTUA_' + 'ES',
      ['PREPAGADA_' + 'CO']: 'kind: PREPAGADA_' + 'CO',
      ['Ley\\s+' + '1581']: 'según la Ley ' + '1581',
      ['Decreto\\s+' + '1377']: 'el Decreto ' + '1377',
      ['Res\\.\\s*' + '839']: 'Res. ' + '839',
      ['Res\\.\\s*' + '1995']: 'Res.' + '1995',
      ['C[eé]dula de ' + 'ciudadan[ií]a']: 'CEDULA DE ' + 'CIUDADANIA',
    };
    for (const term of COUNTRY_TERMS) {
      expect({ term: term.id, ids: termsInLine(samples[term.id]) }).toEqual({
        term: term.id,
        ids: [term.id],
      });
    }
    for (const text of [
      'REP' + 'SOL',
      'CU' + 'PSIDE',
      'RD' + 'AS',
      'standard',
      'cupos',
      'RI' + 'PSAW',
      "'CO" + "PA'",
      'CO' + 'PYRIGHT',
      'es-' + 'COL',
      'de-es-' + 'CO',
      'Clinic' + 'CountryX',
      'legacyClinic' + 'Country',
    ]) {
      expect({ text, ids: termsInLine(text) }).toEqual({ text, ids: [] });
    }
  });

  it('inyección: reporta fichero y línea, respeta la excepción y salta las pruebas', () => {
    const term = 'Clinic' + 'Country';
    const root = fakeSrc({
      'modules/a.ts': `const a = 1;\nexport type ${term} = string;\n`,
      'modules/a.spec.ts': `// ${term}\n`,
      'modules/b.test.tsx': `// ${term}\n`,
      'modules/__fixtures__/c.ts': `// ${term}\n`,
      'modules/c-fixture.json': `{"x":"${term}"}\n`,
    });
    try {
      expect(scanCountryAssumptions(root, [])).toEqual([
        {
          path: 'modules/a.ts',
          line: 2,
          term,
          text: `export type ${term} = string;`,
        },
      ]);
      const ok: CountryException = {
        path: 'modules/a.ts',
        term,
        reason: 'Puente de compatibilidad con las réplicas anteriores.',
      };
      expect(scanCountryAssumptions(root, [ok])).toEqual([]);
      expect(exceptionProblems(root, [ok])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('valida las excepciones: motivo, término conocido y sin duplicados', () => {
    const term = 'Clinic' + 'Country';
    const root = fakeSrc({ 'a.ts': `// ${term}\n` });
    const base = {
      path: 'a.ts',
      term,
      reason: 'Motivo suficientemente largo.',
    };
    try {
      expect(exceptionProblems(root, [base])).toEqual([]);
      const { reason: _omit, ...sinMotivo } = base;
      void _omit;
      for (const bad of [
        sinMotivo as CountryException,
        { ...base, reason: 'corto' },
        { ...base, reason: '                         ' },
        { ...base, term: 'Inexistente' },
      ]) {
        expect(exceptionProblems(root, [bad])).toHaveLength(1);
      }
      expect(exceptionProblems(root, [base, { ...base }])).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('una excepción obsoleta falla: fichero inexistente, sin el término o fuera del recorrido', () => {
    const term = 'Clinic' + 'Country';
    const root = fakeSrc({
      'a.ts': 'export const a = 1;\n',
      'b.spec.ts': `// ${term}\n`,
    });
    const reason = 'Motivo suficientemente largo.';
    try {
      expect(
        exceptionProblems(root, [{ path: 'nada.ts', term, reason }]),
      ).toHaveLength(1);
      expect(
        exceptionProblems(root, [{ path: 'a.ts', term, reason }]),
      ).toHaveLength(1);
      expect(
        exceptionProblems(root, [{ path: 'b.spec.ts', term, reason }]),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
