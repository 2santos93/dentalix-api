import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_HORIZON_DAYS,
  exactNamePattern,
  planRetry,
  retryArgs,
  utcDay,
  validateFlakyList,
  type FlakyEntry,
  type JestReport,
} from '../flaky/flaky-list';

// DX-419 (TST-051): la lista de tests intermitentes y el reintento acotado de
// la CI. Primero la lógica pura; después la CLI de verdad contra un proyecto de
// Jest de juguete con un test intermitente SIMULADO (falla la primera vez,
// pasa la segunda), que es la prueba que pide el ticket.

const REPO = join(__dirname, '..', '..');
const TODAY = '2026-11-24';

const entry = (over: Partial<FlakyEntry> = {}): FlakyEntry => ({
  file: 'test/a.e2e-spec.ts',
  test: 'bloque un test',
  ticket: 'DX-419',
  clickup: 'https://app.clickup.com/t/1244errrke0',
  expires: '2026-12-31',
  reason: 'carrera conocida',
  ...over,
});

const validate = (entries: unknown[], exists = true) =>
  validateFlakyList({ entries }, { today: TODAY, fileExists: () => exists });

describe('validateFlakyList (DX-419)', () => {
  it('acepta una entrada completa y vigente (también el mismo día que caduca)', () => {
    expect(validate([entry()])).toEqual({ problems: [], active: [entry()] });
    expect(validate([entry({ expires: TODAY })]).problems).toEqual([]);
  });

  it('una entrada caducada es un problema (CI en rojo) y no se reintenta', () => {
    const r = validate([entry({ expires: '2026-11-23' })]);
    expect(r.active).toEqual([]);
    expect(r.problems).toEqual([
      expect.stringMatching(/caducó el 2026-11-23 \(hoy es 2026-11-24, UTC\)/),
    ]);
  });

  it(`no admite caducidades de más de ${MAX_HORIZON_DAYS} días`, () => {
    expect(validate([entry({ expires: '2027-02-22' })]).problems).toEqual([]);
    expect(validate([entry({ expires: '2027-02-23' })]).problems).toEqual([
      expect.stringMatching(/pasa de 90 días/),
    ]);
  });

  it('exige ticket DX-NNN, enlace de ClickUp, motivo, fecha real y un spec que exista', () => {
    const r = validate([
      entry({ ticket: 'TST-051' }),
      entry({ test: 'otro', clickup: 'https://example.com/t/1' }),
      entry({ test: 'tres', reason: ' ' }),
      entry({ test: 'cuatro', expires: '2026-02-30' }),
      entry({ test: 'cinco', file: 'src/a.ts' }),
    ]);
    expect(r.active).toEqual([]);
    expect(r.problems).toEqual([
      expect.stringMatching(/«ticket» debe ser DX-NNN/),
      expect.stringMatching(/«clickup» debe ser/),
      expect.stringMatching(/falta «reason»/),
      expect.stringMatching(/«expires» no es una fecha/),
      expect.stringMatching(/no es un spec de Jest/),
    ]);
    expect(validate([entry()], false).problems).toEqual([
      expect.stringMatching(/el fichero no existe/),
    ]);
  });

  it('rechaza entradas repetidas y una lista sin «entries»', () => {
    expect(validate([entry(), entry()]).problems).toEqual([
      expect.stringMatching(/repetida/),
    ]);
    expect(
      validateFlakyList([], { today: TODAY, fileExists: () => true }).problems,
    ).toEqual([expect.stringMatching(/«entries»/)]);
  });

  it('la lista versionada (test/flaky/flaky-tests.json) es válida hoy', () => {
    const raw: unknown = JSON.parse(
      readFileSync(join(REPO, 'test/flaky/flaky-tests.json'), 'utf8'),
    );
    const r = validateFlakyList(raw, {
      today: utcDay(new Date()),
      fileExists: (f) => existsSync(join(REPO, f)),
    });
    expect(r.problems).toEqual([]);
  });
});

describe('planRetry (DX-419)', () => {
  const report = (
    files: {
      name: string;
      failed?: string[];
      passed?: string[];
      broken?: boolean;
    }[],
  ): JestReport => ({
    success: false,
    numFailedTests: files.reduce((n, f) => n + (f.failed?.length ?? 0), 0),
    numRuntimeErrorTestSuites: files.filter((f) => f.broken).length,
    testResults: files.map((f) => ({
      name: `/repo/${f.name}`,
      status: f.failed?.length || f.broken ? 'failed' : 'passed',
      testExecError: f.broken ? { message: 'SyntaxError' } : undefined,
      assertionResults: [
        ...(f.failed ?? []).map((fullName) => ({ fullName, status: 'failed' })),
        ...(f.passed ?? []).map((fullName) => ({ fullName, status: 'passed' })),
      ],
    })),
  });

  it('reintenta solo si TODOS los fallos están en la lista', () => {
    const plan = planRetry(
      report([
        {
          name: 'test/a.e2e-spec.ts',
          failed: ['bloque un test'],
          passed: ['bloque otro'],
        },
      ]),
      [entry()],
      '/repo',
    );
    expect(plan.retryable).toBe(true);
    expect(plan.listed).toEqual([
      { file: 'test/a.e2e-spec.ts', test: 'bloque un test', entry: entry() },
    ]);
  });

  it('un fallo fuera de la lista (aunque otro sí esté) impide todo reintento', () => {
    const plan = planRetry(
      report([
        { name: 'test/a.e2e-spec.ts', failed: ['bloque un test'] },
        { name: 'test/b.e2e-spec.ts', failed: ['bloque un test'] },
      ]),
      [entry()],
      '/repo',
    );
    expect(plan.retryable).toBe(false);
    expect(plan.notListed).toEqual([
      { file: 'test/b.e2e-spec.ts', test: 'bloque un test' },
    ]);
  });

  it('el mismo nombre en otro describe no cuenta: casa el fullName exacto', () => {
    const plan = planRetry(
      report([{ name: 'test/a.e2e-spec.ts', failed: ['otro bloque un test'] }]),
      [entry()],
      '/repo',
    );
    expect(plan.retryable).toBe(false);
  });

  it('un fichero que no llegó a correr no se reintenta', () => {
    const plan = planRetry(
      report([
        { name: 'test/a.e2e-spec.ts', failed: ['bloque un test'] },
        { name: 'test/c.e2e-spec.ts', broken: true },
      ]),
      [entry()],
      '/repo',
    );
    expect(plan.retryable).toBe(false);
    expect(plan.brokenFiles).toEqual(['test/c.e2e-spec.ts']);
  });
});

describe('argumentos del reintento (DX-419)', () => {
  it('el patrón casa exactamente con el nombre, aunque lleve caracteres de regex', () => {
    const name = 'Bloqueo (DX-048) › 10 [a|b] * «x»?';
    const re = new RegExp(exactNamePattern([name, name]));
    expect(re.test(name)).toBe(true);
    expect(re.test(`${name} y más`)).toBe(false);
    expect(re.test(`pre ${name}`)).toBe(false);
  });

  it('quita el shard y el informe del comando y añade solo esos ficheros y tests', () => {
    expect(
      retryArgs(
        [
          '--config',
          './test/jest-e2e.json',
          '--runInBand',
          '--shard=2/7',
          '--json',
          '--outputFile=x.json',
        ],
        [{ file: 'test/a.e2e-spec.ts', test: 'bloque un test' }],
        '/repo',
      ),
    ).toEqual([
      '--config',
      './test/jest-e2e.json',
      '--runInBand',
      '--testNamePattern',
      '^(?:bloque un test)$',
      '--runTestsByPath',
      '/repo/test/a.e2e-spec.ts',
    ]);
    expect(
      retryArgs(
        ['--shard', '1/2', '--ci'],
        [{ file: 'f.spec.ts', test: 't' }],
        '/r',
      ),
    ).toEqual([
      '--ci',
      '--testNamePattern',
      '^(?:t)$',
      '--runTestsByPath',
      '/r/f.spec.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// La CLI de verdad (test/flaky/cli.ts) contra un proyecto de Jest de juguete.

const JEST = join(REPO, 'node_modules', '.bin', 'jest');
const TS_NODE = join(
  REPO,
  'node_modules',
  'ts-node',
  'register',
  'transpile-only',
);
const CLI = join(REPO, 'test', 'flaky', 'cli.ts');

/**
 * Un spec de juguete. `flaky`: falla la primera vez que corre y pasa la
 * segunda (marca en disco). `rojo`: falla siempre. `verde`: pasa siempre.
 * Cada ejecución de un test deja una línea en runs.log.
 */
function toySpec(
  dir: string,
  file: string,
  tests: Record<string, 'flaky' | 'rojo' | 'verde'>,
): void {
  const body = Object.entries(tests)
    .map(
      ([name, kind]) => `
  it(${JSON.stringify(name)}, () => {
    fs.appendFileSync(${JSON.stringify(join(dir, 'runs.log'))}, ${JSON.stringify(`${file} › bloque ${name}`)} + '\\n');
    ${
      kind === 'flaky'
        ? `const mark = ${JSON.stringify(join(dir, `${file}-${name}.mark`))};
    if (!fs.existsSync(mark)) { fs.writeFileSync(mark, ''); throw new Error('intermitente simulado'); }`
        : kind === 'rojo'
          ? `throw new Error('rojo de verdad');`
          : ''
    }
  });`,
    )
    .join('\n');
  writeFileSync(
    join(dir, file),
    `const fs = require('node:fs');\ndescribe('bloque', () => {${body}\n});\n`,
  );
}

function runCli(
  dir: string,
  entries: Partial<FlakyEntry>[],
  extra: string[] = [],
) {
  writeFileSync(
    join(dir, 'flaky.json'),
    JSON.stringify({ entries: entries.map((e) => entry(e)) }),
  );
  const summaryFile = join(dir, 'summary.md');
  writeFileSync(summaryFile, '');
  const res = spawnSync(
    process.execPath,
    [
      '-r',
      TS_NODE,
      CLI,
      'run',
      '--label',
      'Juguete',
      '--',
      JEST,
      '--config',
      'jest.config.json',
      '--ci',
      ...extra,
    ],
    {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        TS_NODE_PROJECT: join(REPO, 'tsconfig.json'),
        FLAKY_LIST: 'flaky.json',
        FLAKY_TODAY: TODAY,
        GITHUB_STEP_SUMMARY: summaryFile,
      },
    },
  );
  const runs = existsSync(join(dir, 'runs.log'))
    ? readFileSync(join(dir, 'runs.log'), 'utf8').trim().split('\n')
    : [];
  return {
    status: res.status,
    out: `${res.stdout}${res.stderr}`,
    summary: readFileSync(summaryFile, 'utf8'),
    runs,
  };
}

describe('cli.ts run: CI con un test intermitente simulado (DX-419)', () => {
  jest.setTimeout(60_000);
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dx419-'));
    writeFileSync(
      join(dir, 'jest.config.json'),
      JSON.stringify({
        testEnvironment: 'node',
        testRegex: '\\.spec\\.js$',
        rootDir: dir,
      }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('un intermitente de la lista se reintenta una vez, solo él, y el paso sale verde', () => {
    toySpec(dir, 'a.spec.js', { flaky: 'flaky', estable: 'verde' });
    const r = runCli(dir, [{ file: 'a.spec.js', test: 'bloque flaky' }]);
    expect(r.status).toBe(0);
    // El estable corrió una vez; el intermitente, dos (fallo + reintento).
    expect(r.runs.sort()).toEqual([
      'a.spec.js › bloque estable',
      'a.spec.js › bloque flaky',
      'a.spec.js › bloque flaky',
    ]);
    expect(r.summary).toContain('### Intermitentes (DX-419): Juguete');
    expect(r.summary).toContain('verde en el reintento');
    expect(r.summary).toContain('| `a.spec.js` | bloque flaky | [DX-419]');
    expect(r.out).toContain(
      '::warning title=Test intermitente reintentado (DX-419)::a.spec.js › bloque flaky',
    );
  });

  it('un intermitente que NO está en la lista nunca se reintenta', () => {
    toySpec(dir, 'a.spec.js', { flaky: 'flaky' });
    const r = runCli(dir, []);
    expect(r.status).toBe(1);
    expect(r.runs).toEqual(['a.spec.js › bloque flaky']);
    expect(r.summary).toContain('Rojo **sin reintento**');
    expect(r.summary).toContain(
      'fuera de la lista: `a.spec.js` › bloque flaky',
    );
  });

  it('con un fallo fuera de la lista no se reintenta tampoco el de la lista', () => {
    toySpec(dir, 'a.spec.js', { flaky: 'flaky' });
    toySpec(dir, 'b.spec.js', { otro: 'rojo' });
    const r = runCli(dir, [{ file: 'a.spec.js', test: 'bloque flaky' }]);
    expect(r.status).toBe(1);
    expect(r.runs.sort()).toEqual([
      'a.spec.js › bloque flaky',
      'b.spec.js › bloque otro',
    ]);
  });

  it('una entrada caducada no se reintenta', () => {
    toySpec(dir, 'a.spec.js', { flaky: 'flaky' });
    const r = runCli(dir, [
      { file: 'a.spec.js', test: 'bloque flaky', expires: '2026-11-01' },
    ]);
    expect(r.status).toBe(1);
    expect(r.runs).toEqual(['a.spec.js › bloque flaky']);
    expect(r.out).toMatch(
      /::warning title=Intermitentes \(DX-419\)::.*caducó el 2026-11-01/,
    );
  });

  it('un test de la lista que falla también al reintentar deja el paso en rojo', () => {
    toySpec(dir, 'a.spec.js', { siempre: 'rojo' });
    const r = runCli(dir, [{ file: 'a.spec.js', test: 'bloque siempre' }]);
    expect(r.status).toBe(1);
    expect(r.runs).toEqual([
      'a.spec.js › bloque siempre',
      'a.spec.js › bloque siempre',
    ]);
    expect(r.summary).toContain('rojo también en el reintento');
  });

  it('un fichero que no compila no se reintenta', () => {
    toySpec(dir, 'a.spec.js', { flaky: 'flaky' });
    writeFileSync(join(dir, 'roto.spec.js'), 'describe(');
    const r = runCli(dir, [{ file: 'a.spec.js', test: 'bloque flaky' }]);
    expect(r.status).toBe(1);
    expect(r.runs).toEqual(['a.spec.js › bloque flaky']);
    expect(r.summary).toContain(
      'fichero que no llegó a correr: `roto.spec.js`',
    );
  });

  it('verde a la primera: lo dice el resumen y no reintenta nada', () => {
    toySpec(dir, 'a.spec.js', { estable: 'verde' });
    const r = runCli(dir, [], ['--shard=1/1']);
    expect(r.status).toBe(0);
    expect(r.runs).toEqual(['a.spec.js › bloque estable']);
    expect(r.summary).toContain('Verde a la primera: ningún test reintentado.');
  });
});

describe('cli.ts check (DX-419)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dx419-check-'));
    writeFileSync(join(dir, 'a.spec.ts'), '');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function check(entries: Partial<FlakyEntry>[]) {
    writeFileSync(
      join(dir, 'flaky.json'),
      JSON.stringify({ entries: entries.map((e) => entry(e)) }),
    );
    const summaryFile = join(dir, 'summary.md');
    appendFileSync(summaryFile, '');
    const res = spawnSync(process.execPath, ['-r', TS_NODE, CLI, 'check'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        TS_NODE_PROJECT: join(REPO, 'tsconfig.json'),
        FLAKY_LIST: 'flaky.json',
        FLAKY_TODAY: TODAY,
        GITHUB_STEP_SUMMARY: summaryFile,
      },
    });
    return {
      status: res.status,
      out: `${res.stdout}${res.stderr}`,
      summary: readFileSync(summaryFile, 'utf8'),
    };
  }

  it('vigente: sale con 0 y nombra la entrada en el resumen', () => {
    const r = check([{ file: 'a.spec.ts' }]);
    expect(r.status).toBe(0);
    expect(r.summary).toContain(
      '| `a.spec.ts` | bloque un test | [DX-419](https://app.clickup.com/t/1244errrke0) | 2026-12-31 |',
    );
  });

  it('caducada: sale con 1 y la nombra con ::error', () => {
    const r = check([{ file: 'a.spec.ts', expires: '2026-11-20' }]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(
      /::error title=Intermitentes \(DX-419\)::entrada 1 \(a\.spec\.ts\): caducó el 2026-11-20/,
    );
  });

  it('vacía: sale con 0 y lo dice', () => {
    const r = check([]);
    expect(r.status).toBe(0);
    expect(r.summary).toContain('**vacía**');
  });
});

describe('la CI reintenta solo por la lista (DX-419)', () => {
  const ci = readFileSync(
    join(REPO, '.github/workflows/ci.yml'),
    'utf8',
  ).replace(/\s+/g, ' ');
  const scripts = (
    JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  it.each(['test:int', 'test:e2e'])(
    'el paso de %s pasa por cli.ts run con el mismo comando que el script de npm',
    (script) => {
      expect(ci).toContain(`test/flaky/cli.ts run --label`);
      expect(ci).toContain(`-- npx ${scripts[script]} --shard=`);
    },
  );

  it('unit pasa por cli.ts run y `npm test` sigue siendo jest a secas', () => {
    expect(scripts.test).toBe('jest');
    expect(ci).toContain('cli.ts run --label "Unit" -- npx jest');
    expect(ci).toContain('test/flaky/cli.ts check');
  });

  it('ningún spec ni config se reintenta por su cuenta (jest.retryTimes, retryTimes en config)', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules') continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|json)$/.test(name) && path !== __filename) {
          if (/retryTimes/.test(readFileSync(path, 'utf8')))
            offenders.push(path);
        }
      }
    };
    walk(join(REPO, 'src'));
    walk(join(REPO, 'test'));
    expect(offenders).toEqual([]);
  });
});

describe('scripts de shell sin la carrera de `| grep -q` con pipefail (DX-419)', () => {
  // Con `set -o pipefail`, `cmd | grep -q x` falla (141, SIGPIPE) si grep
  // encuentra la línea y sale mientras `cmd` aún escribe. Así falló una vez el
  // humo de la imagen de la web; se captura la salida y se busca después.
  const shellScripts = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory()
        ? shellScripts(join(dir, d.name))
        : d.name.endsWith('.sh')
          ? [join(dir, d.name)]
          : [],
    );
  const files = [
    ...shellScripts(join(REPO, '.github', 'scripts')),
    ...shellScripts(join(REPO, 'scripts')),
  ].map((f) => f.slice(REPO.length + 1));

  it.each(files)('%s', (file) => {
    const text = readFileSync(join(REPO, file), 'utf8');
    if (!/pipefail/.test(text)) return;
    const offenders = text
      .split('\n')
      .filter(
        (line) =>
          !line.trim().startsWith('#') &&
          /\|\s*grep\s+(-\w*q|--quiet)/.test(line),
      );
    expect(offenders).toEqual([]);
  });
});
