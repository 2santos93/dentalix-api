import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DX-082: los scripts de copia y restauración, sin Postgres ni age reales
// (unit, corre en `npm test`). pg_dump, psql y age son stubs en un PATH
// temporal que registran sus argumentos: así se comprueba que el script falla
// con código ≠ 0, no deja un volcado a medias y nunca pasa ni imprime la
// contraseña. La prueba con Postgres y age reales es
// test/backup/backup-restore.int-spec.ts.

const SCRIPTS = join(__dirname, '..', '..', 'scripts');
const ALL = ['backup-db.sh', 'restore-check.sh', 'backup-retention.sh'];
const PASSWORD = 'S3cr3t-no-debe-salir';
const URL = `postgresql://dx_backup:${PASSWORD}@db.internal:5433/dentalix?schema=public&sslmode=require`;

let dir: string;
let bin: string;
let out: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dx082-'));
  bin = join(dir, 'bin');
  out = join(dir, 'out');
  log = join(dir, 'stub.log');
  mkdirSync(bin);
  mkdirSync(out);
  writeFileSync(join(dir, 'recipients.txt'), 'age1stubrecipient\n');
  stub(
    'pg_dump',
    `printf 'pg_dump %s\\n' "$*" >> "$STUB_LOG"
env | grep '^PG' | sort >> "$STUB_LOG"
if [ "\${STUB_PG_DUMP_FAIL:-}" = 1 ]; then
  echo 'pg_dump: error: connection to server failed' >&2
  exit 1
fi
printf 'PGDMP-stub-dump'`,
  );
  // psql en sesión (coproc): responde a la exportación del snapshot y a la
  // consulta del manifiesto, una línea por respuesta.
  stub(
    'psql',
    `printf 'psql %s\\n' "$*" >> "$STUB_LOG"
while IFS= read -r line; do
  case "$line" in
    *pg_export_snapshot*) echo '00000003-0000001B-1' ;;
    *dx082_manifest*) echo '{"format":"dx082-manifest/1","tables":{"public.patients":3}}' ;;
    '\\q') exit 0 ;;
  esac
done`,
  );
  stub(
    'age',
    `printf 'age %s\\n' "$*" >> "$STUB_LOG"
o=''
while [ $# -gt 0 ]; do
  case "$1" in -o) o="$2"; shift ;; esac
  shift
done
cat > "$o"`,
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stub(name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const res = spawnSync(join(SCRIPTS, script), args, {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      STUB_LOG: log,
      HOME: dir,
      ...env,
    },
  });
  return {
    status: res.status,
    stdout: res.stdout,
    out: `${res.stdout}${res.stderr}`,
  };
}

function stubLog(): string {
  return existsSync(log) ? readFileSync(log, 'utf8') : '';
}

describe('scripts de copia (DX-082): forma', () => {
  it.each(ALL)('%s es bash estricto, ejecutable y sin credenciales', (f) => {
    const path = join(SCRIPTS, f);
    const src = readFileSync(path, 'utf8');
    expect(src.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(src).toMatch(/^set -euo pipefail$/m);
    // Ninguna URL con usuario:contraseña@ ni claves de age privadas.
    expect(src).not.toMatch(/:\/\/[^/\s:@'"]+:[^@\s'"]+@/);
    expect(src).not.toMatch(/AGE-SECRET-KEY-1[0-9A-Z]{20,}/);
    expect(spawnSync('bash', ['-n', path]).status).toBe(0);
    expect(spawnSync('test', ['-x', path]).status).toBe(0);
  });

  it('shellcheck limpio (se salta si no está instalado)', () => {
    const which = spawnSync('bash', ['-c', 'command -v shellcheck']);
    if (which.status !== 0) {
      console.warn(
        '[DX-082] SALTADO shellcheck: no está instalado en este entorno.',
      );
      return;
    }
    const files = [...ALL.map((f) => join(SCRIPTS, f))];
    const r = spawnSync('shellcheck', ['-x', ...files], { encoding: 'utf8' });
    expect(r.stdout).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('backup-db.sh (DX-082) con stubs', () => {
  const recipients = () => ({
    BACKUP_AGE_RECIPIENTS_FILE: join(dir, 'recipients.txt'),
  });

  it('sin conexión configurada falla y dice qué falta', () => {
    const r = run('backup-db.sh', ['--out-dir', out], recipients());
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('BACKUP_DATABASE_URL');
  });

  it('sin clave pública falla antes de volcar nada', () => {
    const r = run('backup-db.sh', ['--out-dir', out], {
      BACKUP_DATABASE_URL: URL,
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('BACKUP_AGE_RECIPIENTS_FILE');
    expect(stubLog()).not.toContain('pg_dump ');
  });

  it('si pg_dump falla sale con ≠ 0, no deja ficheros y no muestra la contraseña', () => {
    const r = run('backup-db.sh', ['--out-dir', out], {
      BACKUP_DATABASE_URL: URL,
      STUB_PG_DUMP_FAIL: '1',
      ...recipients(),
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('pg_dump');
    expect(r.out).not.toContain(PASSWORD);
    expect(readdirSync(out)).toEqual([]);
  });

  it('vuelca cifrado con nombre UTC, SHA-256 y manifiesto, sin la contraseña en argv ni en la salida', () => {
    const r = run(
      'backup-db.sh',
      ['--out-dir', out, '--prefix', 'dentalix-prod'],
      { BACKUP_DATABASE_URL: URL, ...recipients() },
    );
    expect(r.out).not.toContain(PASSWORD);
    expect(r.status).toBe(0);

    const files = readdirSync(out).sort();
    expect(files).toHaveLength(3);
    const [dump, sha, manifest] = files;
    expect(dump).toMatch(/^dentalix-prod_\d{8}T\d{6}Z\.dump\.age$/);
    expect(manifest).toBe(dump.replace(/\.dump\.age$/, '.manifest.json'));
    expect(sha).toBe(`${dump}.sha256`);

    // El sha256 se comprueba con `sha256sum -c` desde el directorio.
    const check = spawnSync('sha256sum', ['-c', sha], {
      cwd: out,
      encoding: 'utf8',
    });
    expect(check.status).toBe(0);

    const m = JSON.parse(readFileSync(join(out, manifest), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(m).toMatchObject({
      format: 'dx082-manifest/1',
      tables: { 'public.patients': 3 },
      file: dump,
    });
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);

    // La URL se pasa a libpq por variables de entorno, nunca por argv; el
    // `?schema=` de Prisma no llega a libpq.
    const logged = stubLog();
    expect(logged).toMatch(/^pg_dump .*--snapshot=00000003-0000001B-1/m);
    expect(logged).toMatch(/^pg_dump .*-Fc/m);
    expect(logged).toContain('PGHOST=db.internal');
    expect(logged).toContain('PGPORT=5433');
    expect(logged).toContain('PGUSER=dx_backup');
    expect(logged).toContain('PGDATABASE=dentalix');
    expect(logged).toContain('PGSSLMODE=require');
    expect(logged).not.toMatch(/^(pg_dump|psql|age) .*S3cr3t/m);
    expect(logged).toMatch(/^age .*-R /m);

    // Una línea JSON de resumen sin secretos.
    const summary = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<
      string,
      unknown
    >;
    expect(summary).toMatchObject({ event: 'backup.ok', file: dump });
  });

  it('--prune borra las diarias caducadas y sus ficheros hermanos, nunca las mensuales', () => {
    const old = 'dentalix-prod_20260915T030000Z';
    const monthly = 'dentalix-prod_20260901T030000Z';
    for (const base of [old, monthly]) {
      for (const ext of ['.dump.age', '.dump.age.sha256', '.manifest.json']) {
        writeFileSync(join(out, `${base}${ext}`), 'x');
      }
    }
    const r = run(
      'backup-db.sh',
      ['--out-dir', out, '--prefix', 'dentalix-prod', '--prune'],
      { BACKUP_DATABASE_URL: URL, ...recipients() },
    );
    expect(r.status).toBe(0);
    const files = readdirSync(out);
    expect(files.some((f) => f.startsWith(old))).toBe(false);
    expect(files.filter((f) => f.startsWith(monthly))).toHaveLength(3);
    expect(files.filter((f) => f.endsWith('.dump.age'))).toHaveLength(2);
  });

  it('--prune solo toca su serie: una copia de otro prefijo que empieza igual no «sustituye» a la suya', () => {
    // `dentalix-prod_staging_*` casa con el glob `dentalix-prod_*`. Ayer:
    // prod a las 03:00 y staging a las 04:00. Si se mezclaran, la de prod
    // saldría como superseded-same-day y se borraría.
    const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const day = y.replace(/-/g, '');
    // La de las 00:00 es la primera del mes (o la sustituye la de las 03:00),
    // así la de las 03:00 solo se conserva como la última de su día.
    const first = `dentalix-prod_${day}T000000Z`;
    const prod = `dentalix-prod_${day}T030000Z`;
    const other = `dentalix-prod_staging_${day}T040000Z`;
    for (const base of [first, prod, other]) {
      for (const ext of ['.dump.age', '.dump.age.sha256', '.manifest.json']) {
        writeFileSync(join(out, `${base}${ext}`), 'x');
      }
    }
    const r = run(
      'backup-db.sh',
      ['--out-dir', out, '--prefix', 'dentalix-prod', '--prune'],
      { BACKUP_DATABASE_URL: URL, ...recipients() },
    );
    expect(r.status).toBe(0);
    const files = readdirSync(out);
    expect(files.filter((f) => f.startsWith(prod))).toHaveLength(3);
    expect(files.filter((f) => f.startsWith(other))).toHaveLength(3);
  });

  it('una contraseña con «\\» sin codificar llega intacta a libpq', () => {
    const pass = 'p\\nq%40r';
    const r = run('backup-db.sh', ['--out-dir', out], {
      BACKUP_DATABASE_URL: `postgresql://u:${pass}@h/dentalix`,
      ...recipients(),
    });
    expect(r.status).toBe(0);
    expect(stubLog()).toContain('PGPASSWORD=p\\nq@r\n');
  });
});

describe('restore-check.sh (DX-082) sin BD', () => {
  it('sin --file sale con 2 y muestra el uso', () => {
    const r = run('restore-check.sh', []);
    expect(r.status).toBe(2);
    expect(r.out).toContain('--file');
  });

  it('--tenant exige un uuid (nada de SQL en el argumento)', () => {
    writeFileSync(join(out, 'x.dump.age'), 'x');
    const r = run('restore-check.sh', [
      '--file',
      join(out, 'x.dump.age'),
      '--tenant',
      "1' OR '1'='1",
    ]);
    expect(r.status).toBe(2);
    expect(r.out).toContain('uuid');
  });

  it('falla si el SHA-256 no cuadra, antes de descifrar', () => {
    const f = join(out, 'dentalix_20261031T030000Z.dump.age');
    writeFileSync(f, 'contenido');
    writeFileSync(`${f}.sha256`, `${'0'.repeat(64)}  ${f.split('/').pop()}\n`);
    writeFileSync(join(dir, 'id.txt'), 'stub');
    const r = run('restore-check.sh', ['--file', f], {
      BACKUP_AGE_IDENTITY_FILE: join(dir, 'id.txt'),
      RESTORE_ADMIN_URL: URL,
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('SHA-256');
    expect(r.out).not.toContain(PASSWORD);
    expect(stubLog()).not.toContain('age ');
  });
});
