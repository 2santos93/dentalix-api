import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { ISO4217_CURRENCIES } from '../prisma/reference/iso4217';
import { isValidTimeZone } from '../src/shared/time/civil-day';

// GLOBAL-G1 fase 1 (DX-313, DX-314): moneda, zona y locale por sede. Una BD
// desechable recibe todas las migraciones ANTERIORES y sedes como las dejaba
// el código anterior (CO, ES, con horario en otra zona, con una zona que no
// existe); se aplica la migración y se comprueba el backfill D5, que las
// columnas quedan NULL-ables y sin default para las réplicas antiguas, y que
// la función de backfill es idempotente y no pisa valores elegidos.

const G1 = '20261027120000_g1_location_regional_settings';
// La segunda tanda se queda antes de DX-312: este fichero fija el estado de
// fase 1 de G1 (país en la columna enum, con su valor por defecto).
const DX312 = '20261031120000_dx312_location_country_code';
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

const T1 = '00000000-0000-4000-8000-0000000313a1';
const L_CO = '10000000-0000-4000-8000-000000031301';
const L_ES = '10000000-0000-4000-8000-000000031302';
const L_MX = '10000000-0000-4000-8000-000000031303';
const L_BAD = '10000000-0000-4000-8000-000000031304';
const L_ES_OLD = '10000000-0000-4000-8000-000000031305';
const L_RETIRED = '10000000-0000-4000-8000-000000031306';
const L_LEGACY = '10000000-0000-4000-8000-000000031307';
const L_CHOSEN = '10000000-0000-4000-8000-000000031308';

// Sedes como las dejaba el código anterior: el país por default de BD (CO) o
// explícito, y la zona en su horario vivo (si lo tiene).
const SEED = [
  `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
   VALUES ('${T1}', 'Clínica G1', 'g1-mig', now())`,
  `INSERT INTO "locations" ("id", "tenantId", "name", "country", "deletedAt", "updatedAt")
   VALUES
    ('${L_CO}', '${T1}', 'Sede Centro', DEFAULT, NULL, now()),
    ('${L_ES}', '${T1}', 'Sede Madrid', 'ES', NULL, now()),
    ('${L_MX}', '${T1}', 'Sede Polanco', 'CO', NULL, now()),
    ('${L_BAD}', '${T1}', 'Sede Marte', 'CO', NULL, now()),
    ('${L_ES_OLD}', '${T1}', 'Sede Sevilla', 'ES', NULL, now()),
    ('${L_RETIRED}', '${T1}', 'Sede Cerrada', 'ES', now(), now())`,
  // Polanco: su ADMIN puso México en el horario; Marte: una zona que no
  // existe; Sevilla: un horario BORRADO con otra zona (no cuenta).
  `INSERT INTO "location_schedules" ("id", "tenantId", "locationId", "timezone", "deletedAt", "updatedAt")
   VALUES
    (gen_random_uuid(), '${T1}', '${L_MX}', 'America/Mexico_City', NULL, now()),
    (gen_random_uuid(), '${T1}', '${L_BAD}', 'Mars/Olympus', NULL, now()),
    (gen_random_uuid(), '${T1}', '${L_ES_OLD}', 'Asia/Tokyo', now(), now()),
    (gen_random_uuid(), '${T1}', '${L_CO}', 'America/Bogota', NULL, now())`,
];

interface Regional {
  id: string;
  currency: string | null;
  timeZone: string | null;
  locale: string | null;
  reviewed: boolean;
}

describe('GLOBAL-G1 · migración de fase 1: moneda, zona y locale por sede (int)', () => {
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let db: string;
  let dir: string;
  let target: PrismaClient;

  beforeAll(async () => {
    db = `g1_mig_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'g1-'));
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
    for (const name of all.filter((n) => n < G1)) copy(name);
    migrateDeploy(dir, urlFor(db));
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    for (const sql of SEED) await target.$executeRawUnsafe(sql);
    for (const name of all.filter((n) => n >= G1 && n < DX312)) copy(name);
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

  async function regional(id: string): Promise<Regional> {
    const [row] = await target.$queryRaw<Regional[]>`
      SELECT "id"::text, "currency", "timeZone", "locale",
             "regionalSettingsReviewedAt" IS NOT NULL AS reviewed
        FROM "locations" WHERE "id" = ${id}::uuid`;
    return row;
  }

  async function backfill(tenant?: string): Promise<number> {
    const [row] = tenant
      ? await target.$queryRaw<{ n: number }[]>`
          SELECT dx_g1_backfill_location_regional(${tenant}::uuid) AS n`
      : await target.$queryRaw<{ n: number }[]>`
          SELECT dx_g1_backfill_location_regional() AS n`;
    return row.n;
  }

  it('backfills CO to COP/America/Bogota/es-CO', async () => {
    expect(await regional(L_CO)).toEqual({
      id: L_CO,
      currency: 'COP',
      timeZone: 'America/Bogota',
      locale: 'es-CO',
      reviewed: false,
    });
  });

  it('backfills ES to EUR/Europe/Madrid/es-ES', async () => {
    expect(await regional(L_ES)).toEqual({
      id: L_ES,
      currency: 'EUR',
      timeZone: 'Europe/Madrid',
      locale: 'es-ES',
      reviewed: false,
    });
    // Un horario BORRADO no es la zona efectiva de hoy.
    expect((await regional(L_ES_OLD)).timeZone).toBe('Europe/Madrid');
    // Una sede retirada también queda completa.
    expect(await regional(L_RETIRED)).toMatchObject({
      currency: 'EUR',
      timeZone: 'Europe/Madrid',
      locale: 'es-ES',
    });
  });

  it('backfill keeps the effective zone of a location whose schedule overrides its country', async () => {
    expect(await regional(L_MX)).toEqual({
      id: L_MX,
      currency: 'COP',
      timeZone: 'America/Mexico_City',
      locale: 'es-CO',
      reviewed: false,
    });
  });

  it('ignores an unknown schedule zone and uses the country zone', async () => {
    expect((await regional(L_BAD)).timeZone).toBe('America/Bogota');
  });

  it('every backfilled zone passes isValidTimeZone', async () => {
    const rows = await target.$queryRaw<{ zone: string | null }[]>`
      SELECT DISTINCT "timeZone" AS zone FROM "locations"`;
    expect(rows.length).toBeGreaterThan(0);
    for (const { zone } of rows) {
      expect(zone).not.toBeNull();
      expect([zone, isValidTimeZone(zone as string)]).toEqual([zone, true]);
    }
  });

  it('leaves every location unreviewed', async () => {
    const [row] = await target.$queryRaw<{ total: number; reviewed: number }[]>`
      SELECT count(*)::int AS total,
             count("regionalSettingsReviewedAt")::int AS reviewed
        FROM "locations"`;
    expect(row).toEqual({ total: 6, reviewed: 0 });
  });

  it('legacy: new columns are nullable without default and the country keeps its phase-1 default', async () => {
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
         AND ((table_name = 'locations'
               AND column_name IN ('currency', 'timeZone', 'locale',
                                   'regionalSettingsReviewedAt'))
           OR (table_name = 'pending_registrations'
               AND column_name IN ('locationCountry', 'locationCurrency',
                                   'locationTimeZone', 'locationLocale')))
       ORDER BY table_name, column_name`;
    expect(rows).toEqual([
      {
        table: 'locations',
        column: 'currency',
        type: 'character',
        nullable: 'YES',
        dflt: null,
      },
      {
        table: 'locations',
        column: 'locale',
        type: 'text',
        nullable: 'YES',
        dflt: null,
      },
      {
        table: 'locations',
        column: 'regionalSettingsReviewedAt',
        type: 'timestamp with time zone',
        nullable: 'YES',
        dflt: null,
      },
      {
        table: 'locations',
        column: 'timeZone',
        type: 'text',
        nullable: 'YES',
        dflt: null,
      },
      {
        table: 'pending_registrations',
        column: 'locationCountry',
        type: 'USER-DEFINED',
        nullable: 'YES',
        dflt: null,
      },
      {
        table: 'pending_registrations',
        column: 'locationCurrency',
        type: 'character',
        nullable: 'YES',
        dflt: null,
      },
      {
        table: 'pending_registrations',
        column: 'locationLocale',
        type: 'text',
        nullable: 'YES',
        dflt: null,
      },
      {
        table: 'pending_registrations',
        column: 'locationTimeZone',
        type: 'text',
        nullable: 'YES',
        dflt: null,
      },
    ]);
    // Fase 1: el default de país sigue para los INSERT de réplicas antiguas.
    const [country] = await target.$queryRaw<{ dflt: string | null }[]>`
      SELECT column_default AS dflt FROM information_schema.columns
       WHERE table_name = 'locations' AND column_name = 'country'`;
    expect(country.dflt).toBe(`'CO'::"ClinicCountry"`);
    // La FK y los CHECK admiten NULL y rechazan lo que no es válido.
    await expect(
      target.$executeRawUnsafe(
        `UPDATE "locations" SET "currency" = 'ZZZ' WHERE "id" = '${L_CO}'`,
      ),
    ).rejects.toThrow(/locations_currency_fkey/);
    await expect(
      target.$executeRawUnsafe(
        `UPDATE "locations" SET "locale" = 'x' WHERE "id" = '${L_CO}'`,
      ),
    ).rejects.toThrow(/locations_locale_length_check/);
    await expect(
      target.$executeRawUnsafe(
        `UPDATE "locations" SET "timeZone" = '' WHERE "id" = '${L_CO}'`,
      ),
    ).rejects.toThrow(/locations_time_zone_length_check/);
    // RLS sigue FORZADO tras el backfill.
    const forced = await target.$queryRaw<{ table: string; forced: boolean }[]>`
      SELECT relname AS table, relforcerowsecurity AS forced FROM pg_class
       WHERE oid IN ('public.locations'::regclass,
                     'public.location_schedules'::regclass)
       ORDER BY relname`;
    expect(forced).toEqual([
      { table: 'location_schedules', forced: true },
      { table: 'locations', forced: true },
    ]);
  });

  it('location_schedules.timezone still exists', async () => {
    const [row] = await target.$queryRaw<
      { nullable: string; dflt: string | null }[]
    >`
      SELECT is_nullable AS nullable, column_default AS dflt
        FROM information_schema.columns
       WHERE table_name = 'location_schedules' AND column_name = 'timezone'`;
    expect(row).toEqual({
      nullable: 'NO',
      dflt: `'America/Bogota'::text`,
    });
  });

  it('legacy: old-replica INSERT without regional columns succeeds and leaves NULLs', async () => {
    // Lo que envía el cliente Prisma de la API anterior al crear una sede.
    await target.$executeRawUnsafe(
      `INSERT INTO "locations" ("id", "tenantId", "name", "updatedAt")
       VALUES ('${L_LEGACY}', '${T1}', 'Sede Antigua', now())`,
    );
    expect(await regional(L_LEGACY)).toEqual({
      id: L_LEGACY,
      currency: null,
      timeZone: null,
      locale: null,
      reviewed: false,
    });
  });

  it('backfill function is idempotent and never overwrites chosen values', async () => {
    // Una sede configurada por un ADMIN con valores que no son los de su país.
    await target.$executeRawUnsafe(
      `INSERT INTO "locations" ("id", "tenantId", "name", "country", "currency",
                                "timeZone", "locale", "regionalSettingsReviewedAt", "updatedAt")
       VALUES ('${L_CHOSEN}', '${T1}', 'Sede Tokio', 'CO', 'JPY', 'Asia/Tokyo',
               'ja-JP', now(), now())`,
    );
    // Otra clínica: el barrido por tenant no la toca.
    expect(await backfill('00000000-0000-4000-8000-00000000ffff')).toBe(0);
    expect((await regional(L_LEGACY)).currency).toBeNull();

    expect(await backfill(T1)).toBe(1);
    expect(await regional(L_LEGACY)).toEqual({
      id: L_LEGACY,
      currency: 'COP',
      timeZone: 'America/Bogota',
      locale: 'es-CO',
      reviewed: false,
    });
    expect(await backfill()).toBe(0);
    expect(await backfill(T1)).toBe(0);
    expect(await regional(L_CHOSEN)).toEqual({
      id: L_CHOSEN,
      currency: 'JPY',
      timeZone: 'Asia/Tokyo',
      locale: 'ja-JP',
      reviewed: true,
    });

    // Solo rellena la columna que falta, no pisa las demás.
    await target.$executeRawUnsafe(
      `UPDATE "locations" SET "locale" = NULL WHERE "id" = '${L_CHOSEN}'`,
    );
    expect(await backfill()).toBe(1);
    expect(await regional(L_CHOSEN)).toMatchObject({
      currency: 'JPY',
      timeZone: 'Asia/Tokyo',
      locale: 'es-CO',
    });
  });

  it('treatment_plans.currency has no default', async () => {
    const [row] = await target.$queryRaw<
      { nullable: string; dflt: string | null }[]
    >`
      SELECT is_nullable AS nullable, column_default AS dflt
        FROM information_schema.columns
       WHERE table_name = 'treatment_plans' AND column_name = 'currency'`;
    expect(row).toEqual({ nullable: 'NO', dflt: null });
  });

  it('currencies include COP EUR JPY VND and exclude KWD XAU HRK SLL', async () => {
    const rows = await target.$queryRaw<{ code: string }[]>`
      SELECT "code" FROM "currencies"
       WHERE "code" IN ('COP', 'EUR', 'JPY', 'VND', 'KWD', 'XAU', 'HRK', 'SLL')
       ORDER BY "code"`;
    expect(rows.map((r) => r.code)).toEqual(['COP', 'EUR', 'JPY', 'VND']);
    // Las 10 de antes conservan su nombre y su símbolo.
    const [pen] = await target.$queryRaw<{ name: string; symbol: string }[]>`
      SELECT "name", "symbol" FROM "currencies" WHERE "code" = 'PEN'`;
    expect(pen).toEqual({ name: 'Sol peruano', symbol: 'S/' });
    // La migración siembra exactamente la lista generada que lee el seed.
    const all = await target.$queryRaw<{ code: string }[]>`
      SELECT "code" FROM "currencies" ORDER BY "code"`;
    expect(all.map((r) => r.code)).toEqual(
      ISO4217_CURRENCIES.map((c) => c.code).sort(),
    );
  });
});
