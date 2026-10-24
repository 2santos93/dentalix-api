import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  adminUrlFor,
  ownerUrlFor,
  requireOwnerNosuEnv,
} from './owner-nosu-env';

// DX-134: los roles NOLOGIN `dentalix_patient_search`,
// `dentalix_email_dispatcher` y `dentalix_membership_lookup` (DX-143) son del
// CLÚSTER, y ADMIN OPTION sobre ellos equivale a poder darse SET: quien la
// tenga puede leer `patients`, `email_outbox` y `clinic_memberships` de TODAS
// las bases del clúster. Por eso la restricción es
// un owner por clúster (README, «Despliegue: roles de la BD»):
//   - create-app-role.sql, que corre como el owner ANTES de migrar, aborta
//     con un error que explica la restricción si los roles ya tienen otros
//     miembros (otro owner) y la migración también se niega (nada en
//     silencio);
//   - el mismo owner sí puede tener varias bases en el clúster;
//   - `npm run db:check-force` detecta en cada despliegue un miembro
//     inesperado añadido después (aunque sea solo con ADMIN).

const ROOT = join(__dirname, '..', '..');
const ROLES = [
  'dentalix_patient_search',
  'dentalix_email_dispatcher',
  'dentalix_membership_lookup',
];

/** psql no acepta el `?schema=public` de las URL de Prisma. */
const psqlUrl = (url: string): string => {
  const u = new URL(url);
  u.search = '';
  return u.toString();
};

describe('DX-134 · un owner por clúster: segundo owner con error claro (owner-nosu)', () => {
  const env = requireOwnerNosuEnv();
  const stamp = `${process.pid}_${Date.now()}`;
  const ownerB = `${env.owner.slice(0, 30)}_b_${stamp}`;
  const intruder = `${env.owner.slice(0, 30)}_x_${stamp}`;
  const dbB = `dx134_b_${stamp}`;
  const dbA2 = `dx134_a2_${stamp}`;
  const dir = mkdtempSync(join(tmpdir(), 'dx134-cluster-'));
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: adminUrlFor(env, 'postgres') } },
  });

  /** URL de `db` como el owner B (contraseña de test). */
  function ownerBUrl(db: string): string {
    const u = new URL(ownerUrlFor(env, db));
    u.username = ownerB;
    u.password = 'dx134_owner_b';
    return u.toString();
  }

  function createAppRole(url: string): { status: number | null; out: string } {
    const r = spawnSync(
      'psql',
      [
        psqlUrl(url),
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        join(ROOT, 'docker/prod/create-app-role.sql'),
      ],
      { encoding: 'utf8' },
    );
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  function checkForce(url: string): { status: number | null; out: string } {
    const r = spawnSync(
      join(ROOT, 'node_modules/.bin/ts-node'),
      ['--transpile-only', 'prisma/check-force.ts'],
      {
        cwd: ROOT,
        env: { ...process.env, DIRECT_URL: url, DATABASE_URL: url },
        encoding: 'utf8',
      },
    );
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  /** Mensaje de error de `prisma migrate deploy` ('' si no falla). */
  function deployError(url: string): string {
    try {
      execFileSync(
        join(ROOT, 'node_modules/.bin/prisma'),
        ['migrate', 'deploy', '--schema', join(dir, 'schema.prisma')],
        {
          cwd: ROOT,
          env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
          stdio: 'pipe',
        },
      );
      return '';
    } catch (err) {
      const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
      return `${String(stdout ?? '')}${String(stderr ?? '')}`;
    }
  }

  async function defaultAcls(db: string): Promise<number> {
    const c = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: adminUrlFor(env, db) } },
    });
    try {
      const [row] = await c.$queryRaw<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM pg_default_acl`;
      return row.n;
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
       ORDER BY 1`;
    return rows.map((r) => r.m);
  }

  beforeAll(async () => {
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(join(ROOT, 'prisma/migrations'), join(dir, 'migrations'), {
      recursive: true,
    });
    // Como admin del proveedor: un segundo owner sin superusuario y su base,
    // y una segunda base del primer owner.
    await admin.$executeRawUnsafe(
      `CREATE ROLE "${ownerB}" LOGIN PASSWORD 'dx134_owner_b'
         NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB NOREPLICATION`,
    );
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbB}" OWNER "${ownerB}"`);
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${dbA2}" OWNER "${env.owner}"`,
    );
    // Un rol cualquiera del clúster que se cuela como miembro (último test).
    await admin.$executeRawUnsafe(`CREATE ROLE "${intruder}" NOLOGIN`);
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

  it('el owner que creó los roles es su único miembro, solo con ADMIN', async () => {
    expect(await memberships()).toEqual(
      ROLES.slice()
        .sort()
        .map((r) => `${r}:${env.owner}:true/false/false`),
    );
  });

  it('un segundo owner: create-app-role.sql aborta ANTES de migrar explicando la restricción, y no crea nada', async () => {
    const r = createAppRole(ownerBUrl(dbB));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(
      `Este clúster ya tiene el rol dentalix_patient_search de otro owner (miembros: ${env.owner}). Un owner por clúster: migra esta base con ese owner o usa un clúster distinto`,
    );
    expect(await defaultAcls(dbB)).toBe(0);
  });

  it('un segundo owner: la migración también se niega, de forma ruidosa', () => {
    expect(deployError(ownerBUrl(dbB))).toContain(
      'El rol dentalix_patient_search tiene miembros inesperados',
    );
  }, 300_000);

  it('un segundo owner con ADMIN OPTION del admin sigue rechazado (ADMIN equivale a poder darse SET)', async () => {
    await admin.$executeRawUnsafe(
      `GRANT ${ROLES.join(', ')} TO "${ownerB}" WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
    );
    try {
      const r = createAppRole(ownerBUrl(dbB));
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('Un owner por clúster');
      // Y, para el primer owner, B pasa a ser un miembro inesperado.
      const check = checkForce(env.ownerUrl);
      expect(check.out).toContain(`dentalix_patient_search:${ownerB}`);
      expect(check.status).toBe(1);
    } finally {
      await admin.$executeRawUnsafe(
        `REVOKE ${ROLES.join(', ')} FROM "${ownerB}"`,
      );
    }
    expect(await memberships()).not.toContain(expect.stringContaining(ownerB));
  });

  it('el MISMO owner sí puede tener otra base en el clúster: create-app-role sin contraseña, migración y db:check-force en verde', () => {
    const r = createAppRole(ownerUrlFor(env, dbA2));
    expect(r.out).not.toContain('ERROR');
    expect(r.status).toBe(0);
    expect(deployError(ownerUrlFor(env, dbA2))).toBe('');
    const check = checkForce(ownerUrlFor(env, dbA2));
    expect(check.out).toContain('"event":"db.check_force_ok"');
    expect(check.status).toBe(0);
  }, 300_000);

  it.each(['dentalix_email_dispatcher', 'dentalix_membership_lookup'])(
    'un miembro de %s añadido después, aunque sea solo con ADMIN: db:check-force lo detecta y create-app-role aborta',
    async (role) => {
      await admin.$executeRawUnsafe(
        `GRANT ${role} TO "${intruder}" WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
      );
      try {
        const check = checkForce(env.ownerUrl);
        expect(check.out).toContain('"event":"db.check_force_failed"');
        expect(check.out).toContain(`"members":["${role}:${intruder}"]`);
        expect(check.status).toBe(1);
        const r = createAppRole(ownerUrlFor(env, dbA2));
        expect(r.status).not.toBe(0);
        expect(r.out).toContain(
          `Este clúster ya tiene el rol ${role} de otro owner (miembros: ${intruder})`,
        );
      } finally {
        await admin.$executeRawUnsafe(`REVOKE ${role} FROM "${intruder}"`);
      }
      expect(checkForce(env.ownerUrl).status).toBe(0);
    },
    120_000,
  );
});
