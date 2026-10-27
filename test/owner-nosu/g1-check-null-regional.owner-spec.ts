import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  adminUrlFor,
  ownerUrlFor,
  requireOwnerNosuEnv,
} from './owner-nosu-env';

// GLOBAL-G1: la consulta de «0 sedes sin configurar» del runbook
// (prisma/scripts/g1-check-null-regional.sql) corre como el owner SIN
// superusuario. Un `count(*)` suelto del owner lee 0 por FORCE RLS aunque haya
// sedes sin configurar en varias clínicas (falso 0); el script las cuenta todas
// y deja FORCE como estaba.

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'prisma/scripts/g1-check-null-regional.sql');
const T_A = '00000000-0000-4000-8000-0000003130a1';
const T_B = '00000000-0000-4000-8000-0000003130b1';

describe('GLOBAL-G1 · consulta de comprobación de sedes sin configurar (owner-nosu)', () => {
  const env = requireOwnerNosuEnv();
  const db = `g1_check_${process.pid}_${Date.now()}`;
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: adminUrlFor(env, 'postgres') } },
  });
  let target: PrismaClient;

  function owner(args: string[]): { status: number | null; out: string } {
    const u = new URL(ownerUrlFor(env, db));
    u.search = '';
    const r = spawnSync(
      'psql',
      [u.toString(), '-X', '-tA', '-v', 'ON_ERROR_STOP=1', ...args],
      { encoding: 'utf8' },
    );
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  beforeAll(async () => {
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${db}" OWNER "${env.owner}"`,
    );
    execFileSync(
      join(ROOT, 'node_modules/.bin/prisma'),
      ['migrate', 'deploy'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          DATABASE_URL: ownerUrlFor(env, db),
          DIRECT_URL: ownerUrlFor(env, db),
        },
        stdio: 'pipe',
      },
    );
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: adminUrlFor(env, db) } },
    });
    // Dos clínicas, cada una con una sede como la deja una réplica antigua.
    for (const [id, sub] of [
      [T_A, 'g1-chk-a'],
      [T_B, 'g1-chk-b'],
    ]) {
      await target.$executeRawUnsafe(
        `INSERT INTO "tenants" ("id","name","subdomain","updatedAt")
         VALUES ('${id}','Clínica ${sub}','${sub}',now())`,
      );
      await target.$executeRawUnsafe(
        `INSERT INTO "locations" ("id","tenantId","name","updatedAt")
         VALUES (gen_random_uuid(),'${id}','Sede vieja',now())`,
      );
    }
  }, 300_000);

  afterAll(async () => {
    await target?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    await admin.$disconnect();
  });

  it('un count(*) suelto del owner da 0 (el falso 0), el script cuenta las sedes de todas las clínicas', () => {
    const bare = owner([
      '-c',
      `SELECT 'suelto=' || count(*) FROM public."locations" WHERE currency IS NULL`,
    ]);
    expect(bare.out).toContain('suelto=0');

    const checked = owner(['-f', SCRIPT]);
    expect(checked.status).toBe(0);
    expect(checked.out).toContain('locations_sin_configurar=2');
    expect(checked.out).toContain('pendientes_legados_vigentes=0');
  });

  it('deja FORCE ROW LEVEL SECURITY como estaba', async () => {
    owner(['-f', SCRIPT]);
    const [row] = await target.$queryRaw<{ f: boolean }[]>`
      SELECT relforcerowsecurity AS f FROM pg_class
       WHERE oid = 'public.locations'::regclass`;
    expect(row.f).toBe(true);
  });

  it('tras barrer las sedes, el script da 0', () => {
    execFileSync(
      join(ROOT, 'node_modules/.bin/ts-node'),
      ['--transpile-only', 'prisma/scripts/g1-backfill-locations.ts'],
      {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: adminUrlFor(env, db) },
        stdio: 'pipe',
      },
    );
    expect(owner(['-f', SCRIPT]).out).toContain('locations_sin_configurar=0');
  });
});
