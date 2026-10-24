import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

// DX-319: se borra locations."repsHabilitationCode" y se añade el nº de
// registro sanitario libre. Una BD desechable recibe todas las migraciones
// ANTERIORES y sedes con y sin REPS; se aplica el paso 1 (columnas nuevas), un
// ADMIN escribe su nº en una de ellas, y el paso 2 copia el REPS solo donde no
// hay nº propio y borra la columna sin fallar con datos. Volver a aplicarlo
// (columna ya borrada) no hace nada.

const ADD = '20261024174000_dx319_location_health_registration';
const DROP = '20261024174100_dx319_drop_location_reps';
const ROOT = join(__dirname, '..');

function urlFor(db: string): string {
  const url = new URL(process.env.DIRECT_URL as string);
  url.pathname = `/${db}`;
  return url.toString();
}

function migrateDeploy(dir: string, url: string): void {
  execFileSync(
    join(ROOT, 'node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--schema', join(dir, 'schema.prisma')],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      stdio: 'pipe',
    },
  );
}

const T1 = '00000000-0000-4000-8000-0000000319a1';
const L_REPS = '10000000-0000-4000-8000-000000000001';
const L_NONE = '10000000-0000-4000-8000-000000000002';
const L_OWN = '10000000-0000-4000-8000-000000000003';

// Sedes como las dejaba el código anterior (DX-212).
const SEED = [
  `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
   VALUES ('${T1}', 'Clínica REPS', 'dx319-mig', now())`,
  `INSERT INTO "locations" ("id", "tenantId", "name", "repsHabilitationCode", "updatedAt")
   VALUES
    ('${L_REPS}', '${T1}', 'Sede principal', '110010123401', now()),
    ('${L_NONE}', '${T1}', 'Sede Norte', NULL, now()),
    ('${L_OWN}', '${T1}', 'Sede Sur', '110010123402', now())`,
];

describe('DX-319 · migración del REPS al nº de registro sanitario (int)', () => {
  const admin = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let db: string;
  let dir: string;
  let target: PrismaClient;

  function apply(migration: string): void {
    cpSync(
      join(ROOT, 'prisma/migrations', migration),
      join(dir, 'migrations', migration),
      { recursive: true },
    );
    migrateDeploy(dir, urlFor(db));
  }

  beforeAll(async () => {
    db = `dx319_mig_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'dx319-'));
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(
      join(ROOT, 'prisma/migrations/migration_lock.toml'),
      join(dir, 'migrations/migration_lock.toml'),
    );
    for (const name of readdirSync(join(ROOT, 'prisma/migrations'))) {
      if (name < ADD && !name.endsWith('.toml')) {
        cpSync(
          join(ROOT, 'prisma/migrations', name),
          join(dir, 'migrations', name),
          { recursive: true },
        );
      }
    }
    migrateDeploy(dir, urlFor(db));
    target = new PrismaClient({ datasources: { db: { url: urlFor(db) } } });
    for (const sql of SEED) await target.$executeRawUnsafe(sql);
  }, 180_000);

  afterAll(async () => {
    await target?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    rmSync(dir, { recursive: true, force: true });
    await admin.$disconnect();
  }, 60_000);

  async function columns(): Promise<string[]> {
    const rows = await target.$queryRaw<{ name: string }[]>`
      SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'locations'
         AND column_name IN ('repsHabilitationCode', 'healthRegistrationNumber',
                             'showHealthRegistrationNumber')
       ORDER BY column_name`;
    return rows.map((r) => r.name);
  }

  it('paso 1 añade las columnas (nº null, sin imprimir) y su CHECK; paso 2 copia el REPS sin pisar y borra la columna', async () => {
    apply(ADD);
    expect(await columns()).toEqual([
      'healthRegistrationNumber',
      'repsHabilitationCode',
      'showHealthRegistrationNumber',
    ]);
    // El CHECK nuevo: hasta 64, sin espacios a los lados (la API recorta) y
    // sin caracteres de control.
    for (const bad of ['A'.repeat(65), ' NRS-1', '', 'NRS\t1', 'NRS\n1']) {
      await expect(
        target.$executeRawUnsafe(
          `UPDATE "locations" SET "healthRegistrationNumber" = $1 WHERE "id" = '${L_NONE}'`,
          bad,
        ),
      ).rejects.toThrow(/locations_health_registration_number_check/);
    }
    // Un ADMIN ya escribió su nº en la Sede Sur con el código nuevo.
    await target.$executeRawUnsafe(
      `UPDATE "locations" SET "healthRegistrationNumber" = 'NRS 28/1234-AB',
              "showHealthRegistrationNumber" = true
        WHERE "id" = '${L_OWN}'`,
    );

    apply(DROP);

    expect(await columns()).toEqual([
      'healthRegistrationNumber',
      'showHealthRegistrationNumber',
    ]);
    const rows = await target.$queryRaw<
      { id: string; number: string | null; shown: boolean }[]
    >`
      SELECT "id"::text, "healthRegistrationNumber" AS number,
             "showHealthRegistrationNumber" AS shown
        FROM "locations" ORDER BY "id"`;
    expect(rows).toEqual([
      { id: L_REPS, number: '110010123401', shown: false },
      { id: L_NONE, number: null, shown: false },
      { id: L_OWN, number: 'NRS 28/1234-AB', shown: true },
    ]);
    const checks = await target.$queryRaw<{ name: string }[]>`
      SELECT conname AS name FROM pg_constraint
       WHERE conrelid = 'public.locations'::regclass AND contype = 'c'
       ORDER BY conname`;
    expect(checks.map((c) => c.name)).not.toContain(
      'locations_reps_habilitation_code_format',
    );
    // RLS sigue FORZADO tras la copia.
    const [force] = await target.$queryRaw<{ forced: boolean }[]>`
      SELECT relforcerowsecurity AS forced FROM pg_class
       WHERE oid = 'public.locations'::regclass`;
    expect(force.forced).toBe(true);
  }, 180_000);

  it('el paso 2 es idempotente: sin la columna no hace nada ni falla', async () => {
    // El mismo SQL otra vez, ya sin la columna.
    execFileSync(
      join(ROOT, 'node_modules/.bin/prisma'),
      [
        'db',
        'execute',
        '--url',
        urlFor(db),
        '--file',
        join(ROOT, 'prisma/migrations', DROP, 'migration.sql'),
      ],
      { cwd: ROOT, stdio: 'pipe' },
    );
    const [row] = await target.$queryRaw<{ number: string | null }[]>`
      SELECT "healthRegistrationNumber" AS number FROM "locations"
       WHERE "id" = ${L_REPS}::uuid`;
    expect(row.number).toBe('110010123401');
  }, 60_000);
});
