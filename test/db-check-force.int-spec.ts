import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * DX-134: `npm run db:check-force`, la comprobación tras cada despliegue. Si
 * un `…_reforce_*` falla (p. ej. por `lock_timeout`), la tabla se queda sin
 * FORCE: el owner de las migraciones deja de estar sujeto a la RLS y nada lo
 * vigila fuera de la CI. El script sale con código ≠ 0 y lista las tablas de
 * `public` con RLS activada y sin FORZAR, las de clínica (o particiones de
 * una tabla con RLS) sin RLS, y los miembros inesperados de los roles NOLOGIN
 * del clúster y los DELETE del rol despachador sin su política restrictiva
 * de plataforma (DX-144) (README, runbook de despliegue). Los miembros se prueban en
 * test/owner-nosu/shared-cluster.owner-spec.ts: aquí el clúster es compartido.
 */

const ROOT = join(__dirname, '..');
const TABLE = 'dx134_check_force_probe';
const SCHEMA = 'dx134_check_force_otro';

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

function checkForce(): { status: number | null; out: string } {
  const r = spawnSync(
    join(ROOT, 'node_modules/.bin/ts-node'),
    ['--transpile-only', 'prisma/check-force.ts'],
    { cwd: ROOT, env: process.env, encoding: 'utf8' },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('db:check-force (DX-134)', () => {
  afterAll(async () => {
    await raw.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${TABLE}"`);
    await raw.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await raw.$disconnect();
  });

  it('con todas las migraciones aplicadas sale con 0', () => {
    const { status, out } = checkForce();
    expect(out).toContain('"event":"db.check_force_ok"');
    expect(status).toBe(0);
  }, 60_000);

  it('una tabla de public con RLS y sin FORCE: sale con 1 y la nombra', async () => {
    await raw.$executeRawUnsafe(
      `CREATE TABLE public."${TABLE}" ("id" int PRIMARY KEY)`,
    );
    await raw.$executeRawUnsafe(
      `ALTER TABLE public."${TABLE}" ENABLE ROW LEVEL SECURITY`,
    );
    const { status, out } = checkForce();
    expect(out).toContain('"event":"db.check_force_failed"');
    expect(out).toContain(`"tables":["${TABLE}"]`);
    expect(status).toBe(1);

    await raw.$executeRawUnsafe(
      `ALTER TABLE public."${TABLE}" FORCE ROW LEVEL SECURITY`,
    );
    expect(checkForce().status).toBe(0);
  }, 60_000);

  it('una tabla de clínica (con "tenantId") sin RLS: sale con 1 y la nombra', async () => {
    await raw.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${TABLE}"`);
    await raw.$executeRawUnsafe(
      `CREATE TABLE public."${TABLE}" ("id" int PRIMARY KEY, "tenantId" uuid)`,
    );
    const { status, out } = checkForce();
    expect(out).toContain(`"rls_disabled":["${TABLE}"]`);
    expect(status).toBe(1);
    await raw.$executeRawUnsafe(`DROP TABLE public."${TABLE}"`);
    expect(checkForce().status).toBe(0);
  }, 60_000);

  it('una partición sin RLS de una tabla con RLS: sale con 1 y la nombra', async () => {
    await raw.$executeRawUnsafe(
      `CREATE TABLE public."${TABLE}" ("id" int) PARTITION BY RANGE ("id")`,
    );
    await raw.$executeRawUnsafe(
      `ALTER TABLE public."${TABLE}" ENABLE ROW LEVEL SECURITY`,
    );
    await raw.$executeRawUnsafe(
      `ALTER TABLE public."${TABLE}" FORCE ROW LEVEL SECURITY`,
    );
    await raw.$executeRawUnsafe(
      `CREATE TABLE public."${TABLE}_p1" PARTITION OF public."${TABLE}" FOR VALUES FROM (0) TO (10)`,
    );
    const { status, out } = checkForce();
    expect(out).toContain(`"rls_disabled":["${TABLE}_p1"]`);
    expect(status).toBe(1);
    await raw.$executeRawUnsafe(`DROP TABLE public."${TABLE}"`);
  }, 60_000);

  it('DELETE del rol despachador sin la política restrictiva de plataforma: sale con 1 y nombra la tabla (DX-144)', async () => {
    await raw.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${TABLE}"`);
    await raw.$executeRawUnsafe(
      `CREATE TABLE public."${TABLE}" ("id" int PRIMARY KEY)`,
    );
    await raw.$executeRawUnsafe(
      `GRANT DELETE ON public."${TABLE}" TO dentalix_email_dispatcher`,
    );
    const { status, out } = checkForce();
    expect(out).toContain(`"dispatcher_delete":["${TABLE}"]`);
    // email_outbox tiene la suya: no sale.
    expect(out).not.toContain('"dispatcher_delete":["email_outbox"');
    expect(status).toBe(1);

    await raw.$executeRawUnsafe(
      `REVOKE DELETE ON public."${TABLE}" FROM dentalix_email_dispatcher`,
    );
    expect(checkForce().status).toBe(0);
  }, 60_000);

  it('dentalix_app con una zona horaria que no es UTC: sale con 1 y lo dice en español (DX-226)', async () => {
    // Solo en esta base (IN DATABASE): el rol es del clúster y gana sobre el
    // valor del rol y el de la base.
    const [{ db }] = await raw.$queryRaw<{ db: string }[]>`
      SELECT current_database()::text AS db`;
    await raw.$executeRawUnsafe(
      `ALTER ROLE dentalix_app IN DATABASE "${db}" SET timezone = 'America/Bogota'`,
    );
    try {
      const { status, out } = checkForce();
      expect(out).toContain('"event":"db.check_force_failed"');
      expect(out).toContain(
        '"timezone":["dentalix_app: TimeZone = America/Bogota (tiene que ser UTC)"]',
      );
      expect(out).toContain('la hora del servidor tiene que ser UTC');
      expect(status).toBe(1);
    } finally {
      await raw.$executeRawUnsafe(
        `ALTER ROLE dentalix_app IN DATABASE "${db}" RESET timezone`,
      );
    }
    expect(checkForce().status).toBe(0);
  }, 60_000);

  it('solo mira el esquema public', async () => {
    await raw.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await raw.$executeRawUnsafe(
      `CREATE TABLE "${SCHEMA}"."${TABLE}" ("id" int PRIMARY KEY)`,
    );
    await raw.$executeRawUnsafe(
      `ALTER TABLE "${SCHEMA}"."${TABLE}" ENABLE ROW LEVEL SECURITY`,
    );
    expect(checkForce().status).toBe(0);
  }, 60_000);

  it('sin URL de conexión sale con 2 y lo dice', () => {
    const r = spawnSync(
      join(ROOT, 'node_modules/.bin/ts-node'),
      ['--transpile-only', 'prisma/check-force.ts'],
      {
        cwd: ROOT,
        env: { PATH: process.env.PATH ?? '' },
        encoding: 'utf8',
      },
    );
    expect(`${r.stdout}${r.stderr}`).toContain('db.check_force_error');
    expect(r.status).toBe(2);
  }, 60_000);
});
