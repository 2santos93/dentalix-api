import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  adminUrlFor,
  ownerUrlFor,
  requireOwnerNosuEnv,
} from './owner-nosu-env';

// DX-134: los roles NOLOGIN `dentalix_patient_search` y
// `dentalix_email_dispatcher` son del CLÚSTER. El owner sin superusuario que
// los crea queda como miembro con ADMIN OPTION (PG16, sin SET ni INHERIT), y
// antes la migración de una segunda base, con OTRO owner, abortaba por
// «miembros inesperados». Ahora:
//   - se toleran los miembros que son owners de otra base del clúster con
//     membresía solo ADMIN (sin SET ni INHERIT);
//   - un owner nuevo necesita que el admin del clúster le dé ADMIN OPTION; si
//     no lo tiene, la migración lo dice con el GRANT exacto;
//   - cualquier otro miembro (p. ej. con SET) sigue abortando la migración.
// Ver README, «Despliegue: roles de la BD» (roles NOLOGIN del clúster).

const ROOT = join(__dirname, '..', '..');
const ROLES = ['dentalix_patient_search', 'dentalix_email_dispatcher'];

describe('DX-134 · dos bases de owners distintos en el mismo clúster (owner-nosu)', () => {
  const env = requireOwnerNosuEnv();
  const stamp = `${process.pid}_${Date.now()}`;
  const ownerB = `${env.owner}_b134`.slice(0, 63);
  const intruder = `${env.owner}_x134`.slice(0, 63);
  const dbB = `dx134_b_${stamp}`;
  const dbA2 = `dx134_a2_${stamp}`;
  const dir = mkdtempSync(join(tmpdir(), 'dx134-cluster-'));
  const admin = new PrismaClient({
    datasources: { db: { url: adminUrlFor(env, 'postgres') } },
  });

  /** URL de `db` como el owner B (contraseña de test). */
  function ownerBUrl(db: string): string {
    const u = new URL(ownerUrlFor(env, db));
    u.username = ownerB;
    u.password = 'dx134_owner_b';
    return u.toString();
  }

  /** Prisma CLI con el esquema y TODAS las migraciones del repo. */
  function prisma(url: string, args: string[]): void {
    try {
      execFileSync(
        join(ROOT, 'node_modules/.bin/prisma'),
        [...args, '--schema', join(dir, 'schema.prisma')],
        {
          cwd: ROOT,
          env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
          stdio: 'pipe',
        },
      );
    } catch (err) {
      const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(
        `prisma ${args.join(' ')} falló:\n${String(stdout ?? '')}${String(stderr ?? '')}`,
      );
    }
  }

  async function withDb<T>(
    db: string,
    fn: (c: PrismaClient) => Promise<T>,
  ): Promise<T> {
    const c = new PrismaClient({
      datasources: { db: { url: adminUrlFor(env, db) } },
    });
    try {
      return await fn(c);
    } finally {
      await c.$disconnect();
    }
  }

  /** Membresías de los roles del clúster: "rol:miembro:admin/set/inherit". */
  async function memberships(): Promise<string[]> {
    const rows = await admin.$queryRaw<{ m: string }[]>`
      SELECT g.rolname || ':' || u.rolname || ':' || m.admin_option || '/' ||
             m.set_option || '/' || m.inherit_option AS m
        FROM pg_auth_members m
        JOIN pg_roles g ON g.oid = m.roleid
        JOIN pg_roles u ON u.oid = m.member
       WHERE g.rolname = ANY(${ROLES})
         AND u.rolname IN (${env.owner}, ${ownerB}, ${intruder})
       ORDER BY 1`;
    return rows.map((r) => r.m);
  }

  beforeAll(async () => {
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(join(ROOT, 'prisma/migrations'), join(dir, 'migrations'), {
      recursive: true,
    });
    // Como admin del proveedor: un segundo owner sin superusuario y su base.
    await admin.$executeRawUnsafe(
      `CREATE ROLE "${ownerB}" LOGIN PASSWORD 'dx134_owner_b'
         NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB NOREPLICATION`,
    );
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbB}" OWNER "${ownerB}"`);
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${dbA2}" OWNER "${env.owner}"`,
    );
  });

  afterAll(async () => {
    for (const db of [dbB, dbA2]) {
      await admin.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
      );
    }
    // DROP ROLE retira también sus membresías en los roles del clúster.
    for (const role of [ownerB, intruder]) {
      await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
    await admin.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('el owner de la primera base ya es miembro solo con ADMIN (lo deja así la migración)', async () => {
    expect(await memberships()).toEqual(
      ROLES.slice()
        .sort()
        .map((r) => `${r}:${env.owner}:true/false/false`),
    );
  });

  it('owner B sin ADMIN OPTION: create-app-role.sql pasa sin contraseña y la migración falla con el GRANT exacto', () => {
    const app = spawnSync(
      'psql',
      [
        (() => {
          const u = new URL(ownerBUrl(dbB));
          u.search = '';
          return u.toString();
        })(),
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        join(ROOT, 'docker/prod/create-app-role.sql'),
      ],
      { encoding: 'utf8' },
    );
    expect(`${app.stdout}${app.stderr}`).not.toContain('ERROR');
    expect(app.status).toBe(0);

    expect(() => prisma(ownerBUrl(dbB), ['migrate', 'deploy'])).toThrow(
      `${ownerB} no tiene ADMIN OPTION sobre el rol dentalix_patient_search. Un admin del clúster debe ejecutar antes: GRANT dentalix_patient_search, dentalix_email_dispatcher TO ${ownerB} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
    );
  }, 300_000);

  it('con el GRANT del admin, owner B termina la migración y owner A sigue siendo miembro', async () => {
    await admin.$executeRawUnsafe(
      `GRANT ${ROLES.join(', ')} TO ${ownerB} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
    );
    prisma(ownerBUrl(dbB), [
      'migrate',
      'resolve',
      '--rolled-back',
      '20261017114000_patient_search_and_list_indexes',
    ]);
    prisma(ownerBUrl(dbB), ['migrate', 'deploy']);

    const fns = await withDb(
      dbB,
      (c) =>
        c.$queryRaw<{ f: string }[]>`
        SELECT proname || ':' || pg_get_userbyid(proowner) AS f FROM pg_proc
         WHERE proname IN ('dx_patient_search_ids', 'dx_patient_search_count',
                           'email_outbox_claim', 'email_outbox_settle',
                           'email_outbox_enqueue_platform')
         ORDER BY 1`,
    );
    expect(fns.map((r) => r.f)).toEqual([
      'dx_patient_search_count:dentalix_patient_search',
      'dx_patient_search_ids:dentalix_patient_search',
      'email_outbox_claim:dentalix_email_dispatcher',
      'email_outbox_enqueue_platform:dentalix_email_dispatcher',
      'email_outbox_settle:dentalix_email_dispatcher',
    ]);
    const unforced = await withDb(
      dbB,
      (c) =>
        c.$queryRaw<unknown[]>`
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relrowsecurity AND NOT c.relforcerowsecurity`,
    );
    expect(unforced).toEqual([]);
    // Nadie se queda con SET ni INHERIT: solo ADMIN, como el primer owner.
    expect(await memberships()).toEqual(
      [
        ...ROLES.map((r) => `${r}:${env.owner}:true/false/false`),
        ...ROLES.map((r) => `${r}:${ownerB}:true/false/false`),
      ].sort(),
    );
  }, 300_000);

  it('una base nueva del primer owner migra con owner B como miembro, pero un miembro con SET la sigue abortando', async () => {
    await admin.$executeRawUnsafe(`CREATE ROLE "${intruder}" NOLOGIN`);
    await admin.$executeRawUnsafe(
      `GRANT dentalix_email_dispatcher TO "${intruder}" WITH SET TRUE, INHERIT FALSE`,
    );
    const a2 = ownerUrlFor(env, dbA2);
    try {
      expect(() => prisma(a2, ['migrate', 'deploy'])).toThrow(
        `El rol dentalix_email_dispatcher tiene miembros inesperados: ${intruder}`,
      );
    } finally {
      await admin.$executeRawUnsafe(
        `REVOKE dentalix_email_dispatcher FROM "${intruder}"`,
      );
    }
    prisma(a2, [
      'migrate',
      'resolve',
      '--rolled-back',
      '20261017175000_dx113_email_outbox_dispatcher_role',
    ]);
    prisma(a2, ['migrate', 'deploy']);
    const owners = await withDb(
      dbA2,
      (c) =>
        c.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_proc
         WHERE pg_get_userbyid(proowner) IN ('dentalix_patient_search', 'dentalix_email_dispatcher')`,
    );
    expect(owners[0].n).toBe(5);
  }, 300_000);
});
