import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DX-396 (TST-044): los dos scripts de la e2e repartida en shards de la CI.
// - check-e2e-shards.sh: cada spec en exactamente un shard.
// - report-job-duration.sh: publica la duración y avisa al pasar del 70 %.

const SCRIPTS = join(__dirname, '..', '..', '.github', 'scripts');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dx396-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function list(name: string, specs: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, specs.map((s) => `${s}\n`).join(''));
  return path;
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const res = spawnSync(join(SCRIPTS, script), args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

describe('check-e2e-shards.sh (DX-396)', () => {
  const all = [
    'test/a.e2e-spec.ts',
    'test/b.e2e-spec.ts',
    'test/c.e2e-spec.ts',
  ];

  it('pasa si la unión de los shards es la lista completa sin repetidos', () => {
    const r = run('check-e2e-shards.sh', [
      list('all.txt', all),
      list('s1.txt', ['test/b.e2e-spec.ts']),
      list('s2.txt', ['test/c.e2e-spec.ts', 'test/a.e2e-spec.ts']),
    ]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('3 specs en 2 shards');
  });

  it('falla si un spec corre en dos shards', () => {
    const r = run('check-e2e-shards.sh', [
      list('all.txt', all),
      list('s1.txt', ['test/a.e2e-spec.ts', 'test/b.e2e-spec.ts']),
      list('s2.txt', ['test/b.e2e-spec.ts', 'test/c.e2e-spec.ts']),
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/más de un shard:\ntest\/b\.e2e-spec\.ts/);
  });

  it('falla si un spec no corre en ningún shard', () => {
    const r = run('check-e2e-shards.sh', [
      list('all.txt', all),
      list('s1.txt', ['test/a.e2e-spec.ts']),
      list('s2.txt', ['test/c.e2e-spec.ts']),
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/no corre ningún shard:\ntest\/b\.e2e-spec\.ts/);
  });

  it('falla si un shard viene vacío o trae un spec que no está en la lista', () => {
    const r = run('check-e2e-shards.sh', [
      list('all.txt', all),
      list('s1.txt', [...all, 'test/z.e2e-spec.ts']),
      list('s2.txt', []),
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('no tiene specs');
    expect(r.out).toMatch(
      /no están en la lista completa:\ntest\/z\.e2e-spec\.ts/,
    );
  });
});

describe('report-job-duration.sh (DX-396)', () => {
  const now = 1_800_000_000;

  function report(elapsedSeconds: number) {
    const summary = join(dir, 'summary.md');
    const r = run('report-job-duration.sh', ['E2E 2/3', '20'], {
      JOB_STARTED_AT: String(now - elapsedSeconds),
      JOB_FINISHED_AT: String(now),
      GITHUB_STEP_SUMMARY: summary,
    });
    return { ...r, summary: readFileSync(summary, 'utf8') };
  }

  it('publica la duración en el resumen sin avisar por debajo del 70 %', () => {
    const r = report(13 * 60);
    expect(r.status).toBe(0);
    expect(r.summary).toContain(
      '| 13 min 0 s (780 s) | 20 min | 65 % | 70 % |',
    );
    expect(r.out).not.toContain('::warning');
  });

  it('avisa con ::warning:: al llegar al 70 % del tope', () => {
    const r = report(14 * 60);
    expect(r.status).toBe(0);
    expect(r.summary).toContain('| 14 min 0 s (840 s) | 20 min | 70 % |');
    expect(r.out).toMatch(/^::warning title=E2E 2\/3 cerca del tope::/m);
  });

  it('falla si el job no marcó su inicio', () => {
    const r = run('report-job-duration.sh', ['E2E 1/3', '20']);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('JOB_STARTED_AT');
  });
});
