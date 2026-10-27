import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  REGIONAL_BERLIN_FIXTURE,
  REGIONAL_NEW_YORK_FIXTURE,
  g1LocationInsert,
} from './support/location-fixtures';

// G1-B fase 1 (DX-350): el reloj de cada sede. Una BD desechable recibe todas
// las migraciones ANTERIORES y sedes como las deja GLOBAL-G1 (con moneda, zona
// y formato, revisadas o no, y una retirada); se aplica la migración y se
// comprueba que todas quedan con el reloj que la app ya pintaba (h23), sin
// tocar su revisión, que la columna es NULL-able y sin default para las
// réplicas de G1, y que la función de backfill es idempotente y no pisa un
// reloj elegido.

const G1B = '20261027140000_g1b_location_hour_cycle';
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

const T1 = '00000000-0000-4000-8000-0000000350a1';
const T2 = '00000000-0000-4000-8000-0000000350b1';
const L_REVIEWED = '10000000-0000-4000-8000-000000035001';
const L_UNREVIEWED = '10000000-0000-4000-8000-000000035002';
const L_RETIRED = '10000000-0000-4000-8000-000000035003';
const L_OTHER = '10000000-0000-4000-8000-000000035004';
const REVIEWED_AT = '2026-10-20T10:00:00.000Z';

// Sedes como las deja GLOBAL-G1: valores regionales explícitos y variados.
const SEED = [
  `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
   VALUES ('${T1}', 'Clínica G1-B', 'g1b-mig', now()),
          ('${T2}', 'Otra clínica G1-B', 'g1b-mig-2', now())`,
  `INSERT INTO "locations" ("id", "tenantId", "name", "currency", "timeZone",
                            "locale", "regionalSettingsReviewedAt", "deletedAt", "updatedAt")
   VALUES
    ('${L_REVIEWED}', '${T1}', 'Sede revisada', 'USD', 'America/New_York',
     'en-US', '${REVIEWED_AT}', NULL, now()),
    ('${L_UNREVIEWED}', '${T1}', 'Sede por revisar', 'JPY', 'Asia/Tokyo',
     'ja-JP', NULL, NULL, now()),
    ('${L_RETIRED}', '${T1}', 'Sede cerrada', 'EUR', 'Europe/Berlin',
     'de-DE', NULL, now(), now()),
    ('${L_OTHER}', '${T2}', 'Sede de otra clínica', 'EUR', 'Europe/Berlin',
     'de-DE', '${REVIEWED_AT}', NULL, now())`,
];

interface Clock {
  id: string;
  hourCycle: string | null;
  reviewedAt: string | null;
}

describe('G1-B · migración de fase 1: reloj de la sede (int)', () => {
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let db: string;
  let dir: string;
  let target: PrismaClient;

  beforeAll(async () => {
    db = `g1b_mig_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'g1b-'));
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(
      join(ROOT, 'prisma/migrations/migration_lock.toml'),
      join(dir, 'migrations/migration_lock.toml'),
    );
    const copy = (name: string): void =>
      cpSync(
        join(ROOT, 'prisma/migrations', name),
        join(dir, 'migrations', name),
        { recursive: true },
      );
    const all = readdirSync(join(ROOT, 'prisma/migrations')).filter(
      (name) => !name.endsWith('.toml'),
    );
    for (const name of all.filter((n) => n < G1B)) copy(name);
    migrateDeploy(dir, urlFor(db));
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    for (const sql of SEED) await target.$executeRawUnsafe(sql);
    for (const name of all.filter((n) => n >= G1B)) copy(name);
    migrateDeploy(dir, urlFor(db));
  }, 240_000);

  afterAll(async () => {
    await target?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    rmSync(dir, { recursive: true, force: true });
    await admin.$disconnect();
  }, 60_000);

  async function clock(id: string): Promise<Clock> {
    const [row] = await target.$queryRaw<Clock[]>`
      SELECT "id"::text, "hourCycle",
             to_char("regionalSettingsReviewedAt" AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "reviewedAt"
        FROM "locations" WHERE "id" = ${id}::uuid`;
    return row;
  }

  async function backfill(tenant?: string): Promise<number> {
    const [row] = tenant
      ? await target.$queryRaw<{ n: number }[]>`
          SELECT dx_g1b_backfill_location_hour_cycle(${tenant}::uuid) AS n`
      : await target.$queryRaw<{ n: number }[]>`
          SELECT dx_g1b_backfill_location_hour_cycle() AS n`;
    return row.n;
  }

  it('every existing location gets h23 and keeps regionalSettingsReviewedAt', async () => {
    expect(await clock(L_REVIEWED)).toEqual({
      id: L_REVIEWED,
      hourCycle: 'h23',
      reviewedAt: REVIEWED_AT,
    });
    // Sin aviso de revisión nuevo: el reloj es el que ya se veía.
    expect(await clock(L_UNREVIEWED)).toEqual({
      id: L_UNREVIEWED,
      hourCycle: 'h23',
      reviewedAt: null,
    });
    // Una sede retirada y la de otra clínica también quedan completas.
    expect((await clock(L_RETIRED)).hourCycle).toBe('h23');
    expect(await clock(L_OTHER)).toEqual({
      id: L_OTHER,
      hourCycle: 'h23',
      reviewedAt: REVIEWED_AT,
    });
    const [row] = await target.$queryRaw<{ missing: number }[]>`
      SELECT count(*)::int AS missing FROM "locations" WHERE "hourCycle" IS NULL`;
    expect(row.missing).toBe(0);
  });

  it('hourCycle column is nullable without default and checks h12/h23', async () => {
    const rows = await target.$queryRaw<
      {
        table: string;
        column: string;
        type: string;
        nullable: string;
        dflt: string | null;
      }[]
    >`
      SELECT table_name AS table, column_name AS column,
             data_type AS type, is_nullable AS nullable,
             column_default AS dflt
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'locations' AND column_name = 'hourCycle')
           OR (table_name = 'pending_registrations'
               AND column_name = 'locationHourCycle'))
       ORDER BY table_name, column_name`;
    expect(rows).toEqual([
      {
        table: 'locations',
        column: 'hourCycle',
        type: 'text',
        nullable: 'YES',
        dflt: null,
      },
      {
        table: 'pending_registrations',
        column: 'locationHourCycle',
        type: 'text',
        nullable: 'YES',
        dflt: null,
      },
    ]);
    await expect(
      target.$executeRawUnsafe(
        `UPDATE "locations" SET "hourCycle" = 'h24' WHERE "id" = '${L_REVIEWED}'`,
      ),
    ).rejects.toThrow(/locations_hour_cycle_check/);
    await expect(
      target.$executeRawUnsafe(
        `UPDATE "locations" SET "hourCycle" = 'h11' WHERE "id" = '${L_REVIEWED}'`,
      ),
    ).rejects.toThrow(/locations_hour_cycle_check/);
    // RLS sigue FORZADO tras el backfill.
    const [forced] = await target.$queryRaw<{ forced: boolean }[]>`
      SELECT relforcerowsecurity AS forced FROM pg_class
       WHERE oid = 'public.locations'::regclass`;
    expect(forced.forced).toBe(true);
  });

  it('pending_registrations.locationHourCycle is nullable', async () => {
    const insert = (email: string, clock: string | null) =>
      target.$executeRaw`
        INSERT INTO "pending_registrations"
          ("id", "email", "clinicName", "subdomain", "fullName", "passwordHash",
           "tokenHash", "expiresAt", "locationHourCycle")
        VALUES (gen_random_uuid(), ${email}, 'Clínica', ${email}, 'Ana',
                'x', encode(sha256(convert_to(${email}, 'UTF8')), 'hex'),
                now() + interval '1 day', ${clock})`;
    // La forma de una web de G1: sin reloj.
    await expect(insert('g1-web@g1b.test', null)).resolves.toBe(1);
    await expect(insert('g1b-web@g1b.test', 'h12')).resolves.toBe(1);
    await expect(insert('bad@g1b.test', 'h24')).rejects.toThrow(
      /pending_registrations_location_hour_cycle_check/,
    );
  });

  it('G1 replica INSERT without hourCycle succeeds and leaves NULL', async () => {
    // Lo que envía el cliente Prisma de la API de G1: moneda, zona y formato,
    // sin reloj.
    const id = await g1LocationInsert(
      target,
      T1,
      'Sede de réplica G1',
      REGIONAL_NEW_YORK_FIXTURE,
    );
    expect(await clock(id)).toEqual({ id, hourCycle: null, reviewedAt: null });
    const [row] = await target.$queryRaw<
      { currency: string; timeZone: string; locale: string }[]
    >`SELECT "currency", "timeZone", "locale" FROM "locations"
       WHERE "id" = ${id}::uuid`;
    expect(row).toEqual({
      currency: 'USD',
      timeZone: 'America/New_York',
      locale: 'en-US',
    });
  });

  it('hour cycle backfill is idempotent and never overwrites a chosen h12', async () => {
    const replica = await g1LocationInsert(
      target,
      T1,
      'Otra réplica G1',
      REGIONAL_BERLIN_FIXTURE,
    );
    // Un reloj elegido por un ADMIN.
    await target.$executeRawUnsafe(
      `UPDATE "locations" SET "hourCycle" = 'h12' WHERE "id" = '${L_REVIEWED}'`,
    );
    // Otra clínica: el barrido por tenant no toca T1.
    expect(await backfill(T2)).toBe(0);
    expect((await clock(replica)).hourCycle).toBeNull();

    // Las dos réplicas de G1 de T1 (la de este test y la del anterior).
    expect(await backfill(T1)).toBe(2);
    expect(await clock(replica)).toEqual({
      id: replica,
      hourCycle: 'h23',
      reviewedAt: null,
    });
    expect(await backfill(T1)).toBe(0);
    expect(await backfill()).toBe(0);
    expect(await clock(L_REVIEWED)).toEqual({
      id: L_REVIEWED,
      hourCycle: 'h12',
      reviewedAt: REVIEWED_AT,
    });
  });

  it('the function is SECURITY INVOKER with a fixed search_path and no PUBLIC execute', async () => {
    const [fn] = await target.$queryRaw<
      { definer: boolean; config: string[] | null; publicExec: boolean }[]
    >`
      SELECT p.prosecdef AS definer, p.proconfig AS config,
             EXISTS (SELECT 1
                       FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
               AS "publicExec"
        FROM pg_proc p
       WHERE p.oid = 'public.dx_g1b_backfill_location_hour_cycle(uuid)'::regprocedure`;
    expect(fn).toEqual({
      definer: false,
      config: ['search_path=pg_catalog, public, pg_temp'],
      publicExec: false,
    });
  });
});
