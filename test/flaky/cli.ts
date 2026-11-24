/**
 * DX-419 (TST-051): lista de tests intermitentes y reintento acotado en la CI.
 * La lógica está en flaky-list.ts; aquí solo la E/S.
 *
 *   ts-node --transpile-only test/flaky/cli.ts check
 *     Valida test/flaky/flaky-tests.json (ticket, ClickUp, caducidad, que el
 *     fichero exista) y deja la lista en el resumen del job. Sale con 1 si
 *     una entrada está mal o ha caducado: la CI se pone en rojo.
 *
 *   ts-node --transpile-only test/flaky/cli.ts run --label <etiqueta> -- <jest…>
 *     Lanza el comando de Jest con `--json --outputFile`. Si sale en rojo y
 *     TODOS los fallos son tests vigentes de la lista, los reintenta UNA vez
 *     (solo esos tests, sin `--shard`) y el resultado es el del reintento. Si
 *     hay un solo fallo fuera de la lista, un fichero que no llegó a correr o
 *     Jest no deja informe, no reintenta nada y sale con el código de Jest.
 *     En los dos casos deja en `$GITHUB_STEP_SUMMARY` qué se reintentó.
 *     El comando no debe llevar rutas de tests (el reintento usa
 *     `--runTestsByPath`).
 *
 * Variables: FLAKY_LIST (otra lista, para las pruebas), FLAKY_TODAY
 * (AAAA-MM-DD, para las pruebas; por defecto la fecha UTC de la máquina).
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  listMarkdown,
  planRetry,
  retryArgs,
  summaryMarkdown,
  utcDay,
  validateFlakyList,
  type JestReport,
  type RunOutcome,
} from './flaky-list';

const ROOT = process.cwd();
const LIST = resolve(
  ROOT,
  process.env.FLAKY_LIST ?? 'test/flaky/flaky-tests.json',
);
const TODAY = process.env.FLAKY_TODAY ?? utcDay(new Date());

function summary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
  process.stdout.write(`${markdown}\n`);
}

function loadList(): ReturnType<typeof validateFlakyList> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(LIST, 'utf8'));
  } catch (e) {
    return {
      problems: [`no se pudo leer ${LIST}: ${(e as Error).message}`],
      active: [],
    };
  }
  return validateFlakyList(raw, {
    today: TODAY,
    fileExists: (f) => existsSync(join(ROOT, f)),
  });
}

function check(): number {
  const { problems, active } = loadList();
  for (const p of problems) {
    console.log(`::error title=Intermitentes (DX-419)::${p}`);
  }
  summary(
    `### Intermitentes conocidos (DX-419)\n\n${listMarkdown(active)}${
      problems.length > 0
        ? `\n**${problems.length} problema(s) en la lista** (la CI sale en rojo):\n${problems.map((p) => `- ${p}`).join('\n')}\n`
        : ''
    }`,
  );
  return problems.length > 0 ? 1 : 0;
}

function readReport(file: string): JestReport | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as JestReport;
  } catch {
    return null;
  }
}

function jest(command: string[], outputFile: string): number {
  const [bin, ...args] = command;
  const res = spawnSync(
    bin,
    [...args, '--json', `--outputFile=${outputFile}`],
    {
      stdio: 'inherit',
    },
  );
  return res.status ?? 1;
}

function run(label: string, command: string[]): number {
  const dir = mkdtempSync(join(tmpdir(), 'dx419-'));
  try {
    const first = jest(command, join(dir, 'first.json'));
    if (first === 0) {
      summary(summaryMarkdown(label, { kind: 'passed' }));
      return 0;
    }
    const report = readReport(join(dir, 'first.json'));
    if (!report || report.numFailedTests === 0) {
      summary(
        summaryMarkdown(label, { kind: 'failed-not-retried', plan: null }),
      );
      return first;
    }
    const { problems, active } = loadList();
    for (const p of problems) {
      console.log(
        `::warning title=Intermitentes (DX-419)::${p} (esa entrada no se reintenta)`,
      );
    }
    const plan = planRetry(report, active, ROOT);
    if (!plan.retryable) {
      summary(summaryMarkdown(label, { kind: 'failed-not-retried', plan }));
      return first;
    }
    console.log(
      `\nDX-419: ${plan.listed.length} fallo(s), todos en la lista de intermitentes: un reintento solo de esos tests.\n`,
    );
    const [bin, ...args] = command;
    const second = jest(
      [bin, ...retryArgs(args, plan.listed, ROOT)],
      join(dir, 'retry.json'),
    );
    const retried = readReport(join(dir, 'retry.json'));
    const passed =
      second === 0 && retried !== null && retried.numFailedTests === 0;
    const outcome: RunOutcome = { kind: 'retried', plan, passed };
    for (const t of plan.listed) {
      console.log(
        `::warning title=Test intermitente reintentado (${t.entry.ticket})::${t.file} › ${t.test}: ${
          passed ? 'falló y pasó al reintentar' : 'falló también al reintentar'
        }`,
      );
    }
    summary(summaryMarkdown(label, outcome));
    return passed ? 0 : second || 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === 'check') return check();
  if (cmd === 'run') {
    const sep = rest.indexOf('--');
    const opts = sep === -1 ? rest : rest.slice(0, sep);
    const command = sep === -1 ? [] : rest.slice(sep + 1);
    const labelAt = opts.indexOf('--label');
    const label = labelAt === -1 ? 'Jest' : opts[labelAt + 1];
    if (command.length === 0 || !label) {
      console.error('Uso: cli.ts run --label <etiqueta> -- <comando de jest…>');
      return 2;
    }
    return run(label, command);
  }
  console.error('Uso: cli.ts check | cli.ts run --label <etiqueta> -- <jest…>');
  return 2;
}

process.exit(main(process.argv.slice(2)));
