import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
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
import { describeWithBackupTools, pgUrl, psql } from '../support/backup-tools';

// DX-082: volcado cifrado real (pg_dump -Fc | age) de la base de test y
// comprobación de restauración en una base temporal: SHA-256, descifrado,
// pg_restore, `prisma migrate status`, FORCE RLS (también db:check-force),
// conteo de filas contra el manifiesto y extracción de UNA clínica. La base
// de origen solo se lee; todo lo que se crea se llama dx082_it_* y se borra.

const ROOT = join(__dirname, '..', '..');
const SCRIPTS = join(ROOT, 'scripts');
const PREFIX = 'dx082_it_';
const SLOW = 300_000;

type Report = {
  event: string;
  database: string;
  dropped: boolean;
  encrypted_bytes: number;
  restored_db_bytes: number;
  checks: Record<string, string>;
  counts: {
    tables: number;
    rows: number;
    mismatches: { table: string; expected: number; found: number }[];
  };
  timings_ms: Record<string, number>;
  tenant: null | {
    id: string;
    rows: number;
    tables: Record<string, number>;
    verified: boolean;
    archive: string;
    not_extracted: string[];
  };
};

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
}

function password(url: string): string {
  return decodeURIComponent(new URL(url).password);
}

describeWithBackupTools(
  'copias de la BD y restauración probada (DX-082)',
  (cfg) => {
    let dir: string;
    let key: string;
    let recipients: string;
    let dumpFile: string;
    const srcCopy = `${PREFIX}src_${process.pid}`;

    const leftovers = () =>
      psql(
        cfg.adminUrl,
        `SELECT count(*) FROM pg_database WHERE datname LIKE '${PREFIX}%' AND datname <> '${srcCopy}'`,
      );

    function backup(sourceUrl: string, outDir: string) {
      mkdirSync(outDir, { recursive: true });
      return sh(join(SCRIPTS, 'backup-db.sh'), ['--out-dir', outDir], {
        BACKUP_DATABASE_URL: sourceUrl,
        BACKUP_AGE_RECIPIENTS_FILE: recipients,
        DIRECT_URL: '',
        DATABASE_URL: '',
      });
    }

    function restoreCheck(file: string, extra: string[] = [], identity = key) {
      const report = join(dir, `report-${randomUUID()}.json`);
      const r = sh(
        join(SCRIPTS, 'restore-check.sh'),
        ['--file', file, '--report', report, ...extra],
        {
          RESTORE_ADMIN_URL: cfg.adminUrl,
          RESTORE_DB_PREFIX: PREFIX,
          BACKUP_AGE_IDENTITY_FILE: identity,
          BACKUP_AGE_RECIPIENTS_FILE: recipients,
          DIRECT_URL: '',
          DATABASE_URL: '',
        },
      );
      const json = existsSync(report)
        ? (JSON.parse(readFileSync(report, 'utf8')) as Report)
        : null;
      return { ...r, report: json };
    }

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'dx082-it-'));
      key = join(dir, 'key.txt');
      recipients = join(dir, 'recipients.txt');
      expect(sh('age-keygen', ['-o', key]).status).toBe(0);
      const pub = sh('age-keygen', ['-y', key]);
      expect(pub.status).toBe(0);
      writeFileSync(recipients, pub.stdout);
    });

    afterAll(() => {
      psql(cfg.adminUrl, `DROP DATABASE IF EXISTS ${srcCopy} WITH (FORCE)`);
      rmSync(dir, { recursive: true, force: true });
    });

    it(
      'backup-db.sh vuelca la base cifrada con su SHA-256 y su manifiesto',
      () => {
        const out = join(dir, 'full');
        const r = backup(cfg.sourceUrl, out);
        expect(r.out).toContain('Copia:');
        expect(r.status).toBe(0);
        const pass = password(cfg.sourceUrl);
        if (pass) expect(r.out).not.toContain(pass);

        const files = readdirSync(out).sort();
        expect(files).toHaveLength(3);
        dumpFile = join(out, files[0]);
        expect(files[0]).toMatch(/_\d{8}T\d{6}Z\.dump\.age$/);

        // Cifrado: cabecera de age, nada del formato custom de pg_dump en claro.
        const raw = readFileSync(dumpFile);
        expect(raw.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
        expect(raw.includes(Buffer.from('PGDMP'))).toBe(false);
        expect(
          spawnSync('sha256sum', ['-c', files[1]], { cwd: out }).status,
        ).toBe(0);

        const manifest = JSON.parse(
          readFileSync(join(out, files[2]), 'utf8'),
        ) as {
          tables: Record<string, number>;
          owner: string;
          roles: string[];
        };
        expect(Object.keys(manifest.tables).length).toBeGreaterThan(100);
        expect(manifest.tables['public._prisma_migrations']).toBeGreaterThan(0);
        expect(manifest.roles).toEqual(
          expect.arrayContaining([manifest.owner, 'dentalix_app']),
        );
      },
      SLOW,
    );

    it(
      'el manifiesto lista al owner aunque sea superusuario (el owner de la CI lo es)',
      () => {
        // En postgres:16 de la CI el owner `dentalix` es superusuario; si el
        // manifiesto lo omitiera, --create-missing-roles no lo crearía en un
        // clúster nuevo. Base vacía cuyo owner es el admin (superusuario).
        const suDb = `${PREFIX}su_${process.pid}`;
        psql(cfg.adminUrl, `CREATE DATABASE ${suDb}`);
        try {
          const r = spawnSync(
            'bash',
            [
              '-c',
              '. "$1"; printf "%s;\\n" "$DX_COUNTS_SQL" | psql "$2" -X -A -t -q -v ON_ERROR_STOP=1',
              '_',
              join(SCRIPTS, 'lib', 'dx082-common.sh'),
              pgUrl(cfg.adminUrl, suDb),
            ],
            { encoding: 'utf8' },
          );
          expect(r.status).toBe(0);
          const m = JSON.parse(r.stdout) as { owner: string; roles: string[] };
          expect(
            psql(
              cfg.adminUrl,
              `SELECT rolsuper FROM pg_roles WHERE rolname = '${m.owner}'`,
            ),
          ).toBe('t');
          expect(m.roles).toContain(m.owner);
        } finally {
          psql(cfg.adminUrl, `DROP DATABASE IF EXISTS ${suDb} WITH (FORCE)`);
        }
      },
      SLOW,
    );

    it(
      'restore-check.sh restaura en una base temporal, cuadra conteos, migraciones y FORCE, y la borra',
      () => {
        const r = restoreCheck(dumpFile);
        expect(r.out).not.toMatch(/AGE-SECRET-KEY-1/);
        expect(r.report).not.toBeNull();
        const rep = r.report!;
        expect(rep.checks).toEqual({
          sha256: 'ok',
          decrypt_restore: 'ok',
          migrate_status: 'ok',
          force_rls: 'ok',
          check_force: 'ok',
          counts: 'ok',
        });
        expect(r.status).toBe(0);
        expect(rep.event).toBe('restore_check.ok');
        expect(rep.counts.mismatches).toEqual([]);
        expect(rep.counts.tables).toBeGreaterThan(100);
        expect(rep.restored_db_bytes).toBeGreaterThan(0);
        expect(rep.timings_ms.restore).toBeGreaterThan(0);
        expect(rep.dropped).toBe(true);
        expect(leftovers()).toBe('0');
      },
      SLOW,
    );

    it(
      'falla con otra clave privada y no deja la base temporal',
      () => {
        const other = join(dir, 'other.txt');
        expect(sh('age-keygen', ['-o', other]).status).toBe(0);
        const r = restoreCheck(dumpFile, ['--no-node'], other);
        expect(r.status).not.toBe(0);
        expect(r.report?.checks.decrypt_restore).toBe('failed');
        expect(leftovers()).toBe('0');
      },
      SLOW,
    );

    it(
      'falla si el volcado cifrado se altera, aunque se rehaga el SHA-256',
      () => {
        const tampered = join(
          dir,
          'tampered',
          'dentalix_20261031T030000Z.dump.age',
        );
        mkdirSync(join(dir, 'tampered'));
        copyFileSync(dumpFile, tampered);
        const buf = readFileSync(tampered);
        buf[buf.length - 100] ^= 0xff;
        writeFileSync(tampered, buf);
        const sum = sh('sha256sum', [tampered]).stdout.split(' ')[0];
        writeFileSync(
          `${tampered}.sha256`,
          `${sum}  ${tampered.split('/').pop()}\n`,
        );
        copyFileSync(
          dumpFile.replace(/\.dump\.age$/, '.manifest.json'),
          tampered.replace(/\.dump\.age$/, '.manifest.json'),
        );
        const r = restoreCheck(tampered, ['--no-node']);
        expect(r.status).not.toBe(0);
        expect(r.report?.checks.decrypt_restore).toBe('failed');
        expect(leftovers()).toBe('0');
      },
      SLOW,
    );

    it(
      '--tenant extrae UNA clínica: solo sus filas, cifradas, y las vuelve a cargar para verificarlas',
      () => {
        // Origen con dos clínicas: una copia restaurada de la base de test
        // (--keep) a la que se añaden filas ficticias, sin datos reales.
        const keep = restoreCheck(dumpFile, [
          '--no-node',
          '--keep',
          '--db-name',
          srcCopy,
        ]);
        expect(keep.status).toBe(0);
        const a = randomUUID();
        const b = randomUUID();
        const [ua, ub] = [randomUUID(), randomUUID()];
        const srcUrl = pgUrl(cfg.adminUrl, srcCopy);
        psql(
          srcUrl,
          `
        INSERT INTO tenants (id, name, subdomain, "updatedAt") VALUES
          ('${a}', 'Clínica A dx082', 'dx082-a-${process.pid}', now()),
          ('${b}', 'Clínica B dx082', 'dx082-b-${process.pid}', now());
        INSERT INTO users (id, email, "passwordHash", "fullName", "updatedAt") VALUES
          ('${ua}', 'a-${process.pid}@dx082.invalid', 'x', 'Usuario A', now()),
          ('${ub}', 'b-${process.pid}@dx082.invalid', 'x', 'Usuario B', now());
        INSERT INTO clinic_memberships (id, "tenantId", "userId", role, "updatedAt") VALUES
          ('${randomUUID()}', '${a}', '${ua}', 'ADMIN', now()),
          ('${randomUUID()}', '${b}', '${ub}', 'ADMIN', now());
        INSERT INTO patients (id, "tenantId", "firstName", "lastName", "updatedAt") VALUES
          ('${randomUUID()}', '${a}', 'Ficticio', 'Uno', now()),
          ('${randomUUID()}', '${a}', 'Ficticio', 'Dos', now()),
          ('${randomUUID()}', '${b}', 'Ficticio', 'Tres', now());
        `,
        );

        const out = join(dir, 'two-tenants');
        const bk = backup(srcUrl, out);
        expect(bk.status).toBe(0);
        const file = join(
          out,
          readdirSync(out).find((f) => f.endsWith('.dump.age'))!,
        );

        const tenantOut = join(dir, 'tenant-out');
        const r = restoreCheck(file, [
          '--tenant',
          a,
          '--tenant-out',
          tenantOut,
        ]);
        if (r.status !== 0) console.log(r.out);
        expect(r.report?.checks).toMatchObject({ counts: 'ok', tenant: 'ok' });
        expect(r.status).toBe(0);
        const t = r.report!.tenant!;
        expect(t.id).toBe(a);
        expect(t.verified).toBe(true);
        expect(t.tables).toMatchObject({
          tenants: 1,
          users: 1,
          clinic_memberships: 1,
          patients: 2,
        });
        expect(t.not_extracted).toEqual(expect.arrayContaining(['cities']));
        expect(r.out).not.toContain('Ficticio');
        expect(leftovers()).toBe('0');

        // El archivo de la clínica está cifrado y solo trae a la clínica A.
        const archive = join(tenantOut, t.archive);
        expect(readFileSync(archive).subarray(0, 21).toString()).toBe(
          'age-encryption.org/v1',
        );
        const plain = join(dir, 'tenant-plain');
        mkdirSync(plain);
        const dec = spawnSync(
          'bash',
          [
            '-c',
            'age -d -i "$1" "$2" | tar -x -C "$3"',
            '_',
            key,
            archive,
            plain,
          ],
          { encoding: 'utf8' },
        );
        expect(dec.status).toBe(0);
        const [sub] = readdirSync(plain);
        const patients = readFileSync(join(plain, sub, 'patients.csv'), 'utf8');
        expect(patients).toContain(a);
        expect(patients).not.toContain(b);
        expect(
          readFileSync(join(plain, sub, 'users.csv'), 'utf8'),
        ).not.toContain(ub);
      },
      SLOW,
    );
  },
);
