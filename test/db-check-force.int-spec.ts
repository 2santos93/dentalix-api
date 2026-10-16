import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * DX-134: `npm run db:check-force`, la comprobación tras cada despliegue. Si
 * un `…_reforce_*` falla (p. ej. por `lock_timeout`), la tabla se queda sin
 * FORCE: el owner de las migraciones deja de estar sujeto a la RLS y nada lo
 * vigila fuera de la CI. El script sale con código ≠ 0 y lista las tablas de
 * `public` con RLS activada y sin FORZAR (README, runbook de despliegue).
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
