/**
 * DX-419 (TST-051): tests intermitentes conocidos de la API.
 *
 * Un test intermitente no puede dejar la CI en rojo sin rastro, pero tampoco
 * puede esconderse tras un reintento general. Por eso:
 *
 * - `test/flaky/flaky-tests.json` es la ÚNICA lista de tests que se pueden
 *   reintentar en la CI. Cada entrada nombra el fichero, el nombre completo del
 *   test (el `fullName` de Jest: los `describe` y el `it` separados por un
 *   espacio), el ticket (DX-NNN y su enlace de ClickUp), el motivo y una fecha
 *   de caducidad de como mucho MAX_HORIZON_DAYS días.
 * - `validateFlakyList` la comprueba; `check` (cli.ts) pone la CI en rojo si
 *   una entrada está mal o ha caducado (hoy > `expires`, fecha UTC de la CI).
 * - `planRetry` decide, a partir del informe JSON de Jest, si un rojo se puede
 *   reintentar: solo si TODOS los fallos son tests de la lista (vigentes) y no
 *   hay ningún fichero que no llegó a correr. Un test fuera de la lista nunca
 *   se reintenta. El reintento es uno, solo de esos tests (`-t` exacto).
 * - `summaryMarkdown` deja en `$GITHUB_STEP_SUMMARY` qué se reintentó.
 *
 * Puro (sin E/S salvo lo que se le pasa) para probarlo sin lanzar Jest; el
 * lanzamiento real está en cli.ts y lo prueba test/invariants/flaky-tests.spec.ts
 * con un test intermitente simulado.
 */

/** Una entrada vigente nunca dura más que esto: el arreglo no se aplaza sin fin. */
export const MAX_HORIZON_DAYS = 90;

export interface FlakyEntry {
  /** Ruta desde la raíz del repo, p. ej. `test/login-lockout.e2e-spec.ts`. */
  file: string;
  /** `fullName` de Jest: títulos de los `describe` y del test, con espacios. */
  test: string;
  /** DX-NNN (o DX-NNN-bis…) del ticket que arregla la causa. */
  ticket: string;
  /** Enlace de la tarea en ClickUp (`https://app.clickup.com/t/<id>`). */
  clickup: string;
  /** Último día (UTC, AAAA-MM-DD) en que la entrada vale. */
  expires: string;
  /** Por qué falla a veces (y por qué no se ha arreglado aún). */
  reason: string;
}

export interface FlakyList {
  entries: FlakyEntry[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TICKET_RE = /^DX-\d{3,}(-[a-z]+)?$/;
const CLICKUP_RE = /^https:\/\/app\.clickup\.com\/t\/[A-Za-z0-9_-]+$/;
const SPEC_RE = /\.(spec|int-spec|e2e-spec)\.[jt]s$/;

/** Fecha UTC (AAAA-MM-DD) de `now`: la de la CI, no la de la base de datos. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function isRealDay(day: string): boolean {
  if (!DATE_RE.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && utcDay(parsed) === day;
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDay(d);
}

export const entryKey = (e: Pick<FlakyEntry, 'file' | 'test'>): string =>
  `${e.file} › ${e.test}`;

export interface ValidationResult {
  /** Errores que ponen la CI en rojo (formato, caducidad, ficheros). */
  problems: string[];
  /** Entradas válidas y vigentes: las únicas que se pueden reintentar. */
  active: FlakyEntry[];
}

/**
 * Comprueba la lista. `today` es AAAA-MM-DD (UTC). `fileExists` recibe la ruta
 * de la entrada tal cual (relativa a la raíz del repo).
 */
export function validateFlakyList(
  raw: unknown,
  { today, fileExists }: { today: string; fileExists: (f: string) => boolean },
): ValidationResult {
  const problems: string[] = [];
  const active: FlakyEntry[] = [];
  const entries =
    raw && typeof raw === 'object' && Array.isArray((raw as FlakyList).entries)
      ? (raw as FlakyList).entries
      : null;
  if (!entries) {
    return {
      problems: ['la lista debe ser un objeto con «entries»: [...]'],
      active,
    };
  }
  const horizon = addDays(today, MAX_HORIZON_DAYS);
  const seen = new Set<string>();
  entries.forEach((entry: Partial<FlakyEntry>, i) => {
    const where = `entrada ${i + 1}${typeof entry?.file === 'string' ? ` (${entry.file})` : ''}`;
    const own: string[] = [];
    const str = (k: keyof FlakyEntry): string | null => {
      const v = entry?.[k];
      if (typeof v !== 'string' || v.trim() === '') {
        own.push(`${where}: falta «${k}»`);
        return null;
      }
      return v;
    };
    const file = str('file');
    const test = str('test');
    const ticket = str('ticket');
    const clickup = str('clickup');
    const expires = str('expires');
    str('reason');
    if (file !== null) {
      if (!SPEC_RE.test(file)) {
        own.push(
          `${where}: «file» no es un spec de Jest (*.spec.ts, *.int-spec.ts, *.e2e-spec.ts)`,
        );
      } else if (!fileExists(file)) {
        own.push(
          `${where}: el fichero no existe (¿se movió o se borró? quita la entrada)`,
        );
      }
    }
    if (ticket !== null && !TICKET_RE.test(ticket)) {
      own.push(`${where}: «ticket» debe ser DX-NNN (es «${ticket}»)`);
    }
    if (clickup !== null && !CLICKUP_RE.test(clickup)) {
      own.push(`${where}: «clickup» debe ser https://app.clickup.com/t/<id>`);
    }
    if (expires !== null) {
      if (!isRealDay(expires)) {
        own.push(`${where}: «expires» no es una fecha AAAA-MM-DD`);
      } else if (expires < today) {
        own.push(
          `${where}: caducó el ${expires} (hoy es ${today}, UTC). Arregla el test (${ticket ?? 'sin ticket'}) y quita la entrada, o, si sigue pendiente, renueva la fecha con un motivo nuevo.`,
        );
      } else if (expires > horizon) {
        own.push(
          `${where}: «expires» (${expires}) pasa de ${MAX_HORIZON_DAYS} días (como mucho ${horizon})`,
        );
      }
    }
    if (file !== null && test !== null) {
      const key = entryKey({ file, test });
      if (seen.has(key)) own.push(`${where}: repetida`);
      seen.add(key);
    }
    problems.push(...own);
    if (own.length === 0) active.push(entry as FlakyEntry);
  });
  return { problems, active };
}

// ---------------------------------------------------------------------------
// Informe JSON de Jest (`--json --outputFile`): solo lo que se usa.

export interface JestAssertion {
  fullName: string;
  status: string;
}

export interface JestFileResult {
  /** Ruta absoluta del fichero. */
  name: string;
  status: string;
  message?: string;
  assertionResults: JestAssertion[];
  testExecError?: unknown;
}

export interface JestReport {
  success: boolean;
  numFailedTests: number;
  numRuntimeErrorTestSuites: number;
  testResults: JestFileResult[];
}

export interface FailedTest {
  file: string;
  test: string;
}

export interface RetryPlan {
  /** Fallos de tests de la lista: se reintentan (si `retryable`). */
  listed: (FailedTest & { entry: FlakyEntry })[];
  /** Fallos de tests que no están en la lista: nunca se reintentan. */
  notListed: FailedTest[];
  /** Ficheros que fallaron sin un test concreto (no compilan, beforeAll…). */
  brokenFiles: string[];
  /** true solo si hay fallos y TODOS son de la lista. */
  retryable: boolean;
}

/** Ruta del informe (absoluta) relativa a `root`, con «/». */
export function relativeTo(root: string, file: string): string {
  const r = root.endsWith('/') ? root : `${root}/`;
  return file.startsWith(r) ? file.slice(r.length) : file;
}

export function planRetry(
  report: JestReport,
  active: FlakyEntry[],
  root: string,
): RetryPlan {
  const byKey = new Map(active.map((e) => [entryKey(e), e]));
  const listed: RetryPlan['listed'] = [];
  const notListed: FailedTest[] = [];
  const brokenFiles: string[] = [];
  for (const fileResult of report.testResults) {
    const file = relativeTo(root, fileResult.name);
    const failed = fileResult.assertionResults.filter(
      (a) => a.status === 'failed',
    );
    if (
      fileResult.testExecError ||
      (fileResult.status === 'failed' && failed.length === 0)
    ) {
      brokenFiles.push(file);
      continue;
    }
    for (const a of failed) {
      const entry = byKey.get(entryKey({ file, test: a.fullName }));
      if (entry) listed.push({ file, test: a.fullName, entry });
      else notListed.push({ file, test: a.fullName });
    }
  }
  const retryable =
    listed.length > 0 &&
    notListed.length === 0 &&
    brokenFiles.length === 0 &&
    report.numRuntimeErrorTestSuites === 0;
  return { listed, notListed, brokenFiles, retryable };
}

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `--testNamePattern` que casa EXACTAMENTE con esos nombres completos. */
export function exactNamePattern(names: string[]): string {
  return `^(?:${[...new Set(names)].map(escapeRegExp).join('|')})$`;
}

/**
 * Argumentos del reintento: los del comando original sin el reparto en shards
 * ni el informe (los pone cli.ts), y solo los ficheros y tests reintentados.
 */
export function retryArgs(
  command: string[],
  tests: FailedTest[],
  root: string,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const a = command[i];
    if (a === '--shard' || a === '--outputFile') {
      i++;
      continue;
    }
    if (a.startsWith('--shard=') || a.startsWith('--outputFile=')) continue;
    if (a === '--json') continue;
    out.push(a);
  }
  const files = [...new Set(tests.map((t) => `${root}/${t.file}`))];
  return [
    ...out,
    '--testNamePattern',
    exactNamePattern(tests.map((t) => t.test)),
    '--runTestsByPath',
    ...files,
  ];
}

const cell = (s: string): string => s.replace(/\|/g, '\\|');

/** Tabla de la lista (cada run la nombra en su resumen). */
export function listMarkdown(active: FlakyEntry[]): string {
  if (active.length === 0) {
    return 'Lista de intermitentes conocidos (`test/flaky/flaky-tests.json`): **vacía**. Ningún test se puede reintentar.\n';
  }
  return [
    `Lista de intermitentes conocidos (\`test/flaky/flaky-tests.json\`): ${active.length}. Solo estos se pueden reintentar, una vez.`,
    '',
    '| Fichero | Test | Ticket | Caduca |',
    '| --- | --- | --- | --- |',
    ...active.map(
      (e) =>
        `| \`${cell(e.file)}\` | ${cell(e.test)} | [${e.ticket}](${e.clickup}) | ${e.expires} |`,
    ),
    '',
  ].join('\n');
}

export type RunOutcome =
  | { kind: 'passed' }
  | { kind: 'failed-not-retried'; plan: RetryPlan | null }
  | { kind: 'retried'; plan: RetryPlan; passed: boolean };

/** Resumen de un paso de Jest: qué se reintentó y cómo acabó. */
export function summaryMarkdown(label: string, outcome: RunOutcome): string {
  const head = `### Intermitentes (DX-419): ${label}\n\n`;
  if (outcome.kind === 'passed') {
    return `${head}Verde a la primera: ningún test reintentado.\n`;
  }
  if (outcome.kind === 'failed-not-retried') {
    const plan = outcome.plan;
    const lines = [
      `${head}Rojo **sin reintento**: algún fallo no está en la lista.`,
    ];
    if (plan) {
      for (const t of plan.notListed)
        lines.push(`- fuera de la lista: \`${t.file}\` › ${t.test}`);
      for (const f of plan.brokenFiles)
        lines.push(`- fichero que no llegó a correr: \`${f}\``);
      for (const t of plan.listed)
        lines.push(
          `- de la lista (no reintentado por lo anterior): \`${t.file}\` › ${t.test}`,
        );
    } else {
      lines.push(
        '- Jest no dejó un informe legible (o salió con error sin tests fallidos).',
      );
    }
    return `${lines.join('\n')}\n`;
  }
  const lines = [
    `${head}${outcome.plan.listed.length} test(s) de la lista reintentado(s) una vez: ${
      outcome.passed
        ? '**verde en el reintento**'
        : '**rojo también en el reintento**'
    }.`,
    '',
    '| Fichero | Test | Ticket | Caduca |',
    '| --- | --- | --- | --- |',
    ...outcome.plan.listed.map(
      (t) =>
        `| \`${cell(t.file)}\` | ${cell(t.test)} | [${t.entry.ticket}](${t.entry.clickup}) | ${t.entry.expires} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
