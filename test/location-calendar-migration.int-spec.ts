import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  REGIONAL_BERLIN_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  g1LocationInsert,
  locationData,
} from './support/location-fixtures';

// DX-316 (G1.5): calendario de días hábiles y festivos de la sede.
//
// 1. Una BD desechable recibe todas las migraciones ANTERIORES y sedes como
//    las de hoy (una retirada, otra de otra clínica); se aplican las cuatro
//    de DX-316 y se comprueba que toda sede queda con lunes a viernes y sin
//    festivos, y que FORCE vuelve a las tablas del bracket.
// 2. Sobre la BD de test (ya migrada): el trigger de alta de sede (réplica
//    antigua, rol de la app con y sin `app.current_tenant`), el CASCADE de
//    las limpiezas de test, el RESTRICT de los festivos, los CHECK, los
//    índices únicos parciales, la FK compuesta y el `createdAt` del servidor.
//
// Ningún país, zona ni locale decide nada aquí (R1): los fixtures mezclan
// zonas y formatos sin relación con los días hábiles.

const DX316 = '20261028170000_dx316_enums';
const DEFAULT_MIGRATION = '20261028170300_dx316_location_calendar_default';
const ROOT = join(__dirname, '..');
const MONDAY_TO_FRIDAY = [1, 2, 3, 4, 5];

const CHECK_VIOLATION = /23514/;
const UNIQUE_VIOLATION = /23505/;
const FK_VIOLATION = /23503/;
const RLS_VIOLATION = /row-level security|42501/;

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

/** El SQL de una migración sin sus comentarios. */
function migrationSql(name: string): string {
  return readFileSync(
    join(ROOT, 'prisma/migrations', name, 'migration.sql'),
    'utf8',
  )
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

interface CalendarRow {
  locationId: string;
  workingWeekdays: number[];
}

describe('DX-316 · migraciones del calendario de la sede (int)', () => {
  const T1 = '00000000-0000-4000-8000-0000000316a1';
  const T2 = '00000000-0000-4000-8000-0000000316b1';
  const L_LIVE = '10000000-0000-4000-8000-000000031601';
  const L_RETIRED = '10000000-0000-4000-8000-000000031602';
  const L_OTHER = '10000000-0000-4000-8000-000000031603';

  // Sedes como las deja DX-328, antes de DX-316.
  const SEED = [
    `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
     VALUES ('${T1}', 'Clínica DX-316', 'dx316-mig', now()),
            ('${T2}', 'Otra clínica DX-316', 'dx316-mig-2', now())`,
    `INSERT INTO "locations" ("id", "tenantId", "name", "currency", "timeZone",
                              "locale", "hourCycle", "deletedAt", "updatedAt")
     VALUES
      ('${L_LIVE}', '${T1}', 'Sede viva', 'JPY', 'Asia/Tokyo', 'ja-JP', 'h23',
       NULL, now()),
      ('${L_RETIRED}', '${T1}', 'Sede cerrada', 'EUR', 'Europe/Berlin',
       'de-DE', 'h23', now(), now()),
      ('${L_OTHER}', '${T2}', 'Sede de otra clínica', 'USD',
       'America/New_York', 'en-US', 'h12', NULL, now())`,
  ];

  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let db: string;
  let dir: string;
  let target: PrismaClient;

  beforeAll(async () => {
    db = `dx316_mig_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'dx316-'));
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
    for (const name of all.filter((n) => n < DX316)) copy(name);
    migrateDeploy(dir, urlFor(db));
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    for (const sql of SEED) await target.$executeRawUnsafe(sql);
    for (const name of all.filter((n) => n >= DX316)) copy(name);
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

  it('every existing location gets Monday–Friday and no holidays', async () => {
    const rows = await target.$queryRaw<CalendarRow[]>`
      SELECT l."id"::text AS "locationId",
             c."workingWeekdays"::int[] AS "workingWeekdays"
        FROM "locations" l
        LEFT JOIN "location_working_calendars" c
          ON c."tenantId" = l."tenantId" AND c."locationId" = l."id"
       ORDER BY l."id"`;
    expect(rows).toEqual([
      { locationId: L_LIVE, workingWeekdays: MONDAY_TO_FRIDAY },
      { locationId: L_RETIRED, workingWeekdays: MONDAY_TO_FRIDAY },
      { locationId: L_OTHER, workingWeekdays: MONDAY_TO_FRIDAY },
    ]);
    const [holidays] = await target.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "location_holidays"`;
    expect(holidays.n).toBe(0);
  });

  it('locations and both new tables are FORCE ROW LEVEL SECURITY after the backfill', async () => {
    const rows = await target.$queryRaw<{ rel: string; forced: boolean }[]>`
      SELECT relname AS rel, relforcerowsecurity AS forced FROM pg_class
       WHERE oid IN ('public.locations'::regclass,
                     'public.location_working_calendars'::regclass,
                     'public.location_holidays'::regclass)
       ORDER BY relname`;
    expect(rows).toEqual([
      { rel: 'location_holidays', forced: true },
      { rel: 'location_working_calendars', forced: true },
      { rel: 'locations', forced: true },
    ]);
  });

  it('LOCATION_CALENDAR is a value of AuditResourceType and its partial index exists', async () => {
    const [index] = await target.$queryRaw<{ def: string }[]>`
      SELECT indexdef AS def FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'audit_events_resource_location_calendar_idx'`;
    expect(index.def).toContain(`'LOCATION_CALENDAR'`);
  });

  it('the default weekdays literal lives in one function', async () => {
    const [fn] = await target.$queryRaw<{ weekdays: number[] }[]>`
      SELECT public.dx_location_default_working_weekdays()::int[] AS weekdays`;
    expect(fn.weekdays).toEqual(MONDAY_TO_FRIDAY);
    const [trigger] = await target.$queryRaw<{ def: string }[]>`
      SELECT pg_get_functiondef(
               'public.dx_location_default_working_calendar()'::regprocedure) AS def`;
    expect(trigger.def).not.toContain('{1,2,3,4,5}');
    expect(trigger.def).toContain('dx_location_default_working_weekdays()');
    const [volatility] = await target.$queryRaw<{ v: string }[]>`
      SELECT provolatile::text AS v FROM pg_proc
       WHERE oid = 'public.dx_location_default_working_weekdays()'::regprocedure`;
    expect(volatility.v).toBe('i');
    // En toda la migración el literal aparece una sola vez: el backfill
    // también llama a la función.
    const literals = migrationSql(DEFAULT_MIGRATION).match(/\{1,2,3,4,5\}/g);
    expect(literals).toHaveLength(1);
  });
});

describe('DX-316 · trigger y reglas de la BD del calendario de la sede (int)', () => {
  // `raw` (DIRECT_URL, superusuario) siembra, inspecciona y limpia; la app
  // (DATABASE_URL, dentalix_app, sujeto a RLS) da de alta como la API.
  const raw = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
  const prisma = new PrismaService(new TenantContextService());
  const SUBDOMAINS = ['dx316-int-a', 'dx316-int-b', 'dx316-int-c'];
  let tenantA: string;
  let tenantB: string;
  let locationA: string;
  let locationB: string;

  async function purge(): Promise<void> {
    const tenants = await raw.tenant.findMany({
      where: { subdomain: { in: SUBDOMAINS } },
      select: { id: true },
    });
    const ids = tenants.map((t) => t.id);
    await raw.$executeRaw`
      DELETE FROM "location_holidays" WHERE "tenantId" = ANY(${ids}::uuid[])`;
    // El calendario cae con la sede (ON DELETE CASCADE).
    await raw.location.deleteMany({ where: { tenantId: { in: ids } } });
    await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  }

  async function calendarOf(locationId: string): Promise<number[][]> {
    const rows = await raw.$queryRaw<{ w: number[] }[]>`
      SELECT "workingWeekdays"::int[] AS w FROM "location_working_calendars"
       WHERE "locationId" = ${locationId}::uuid`;
    return rows.map((r) => r.w);
  }

  function insertHoliday(
    date: string,
    name: string,
    recurring = false,
    tenantId = tenantA,
    locationId = locationA,
  ): Promise<number> {
    return raw.$executeRaw`
      INSERT INTO "location_holidays"
        ("id", "tenantId", "locationId", "date", "name", "recurring", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${locationId}::uuid,
              ${date}::date, ${name}, ${recurring}, now())`;
  }

  beforeAll(async () => {
    await purge();
    tenantA = (
      await raw.tenant.create({
        data: { name: 'Clínica DX-316 A', subdomain: SUBDOMAINS[0] },
      })
    ).id;
    tenantB = (
      await raw.tenant.create({
        data: { name: 'Clínica DX-316 B', subdomain: SUBDOMAINS[1] },
      })
    ).id;
    locationA = (
      await raw.location.create({
        data: locationData(REGIONAL_TOKYO_FIXTURE, {
          tenantId: tenantA,
          name: 'Sede A',
        }),
      })
    ).id;
    locationB = (
      await raw.location.create({
        data: locationData(REGIONAL_BERLIN_FIXTURE, {
          tenantId: tenantB,
          name: 'Sede B',
        }),
      })
    ).id;
  });

  afterEach(async () => {
    await raw.$executeRaw`
      DELETE FROM "location_holidays"
       WHERE "tenantId" IN (${tenantA}::uuid, ${tenantB}::uuid)`;
  });

  afterAll(async () => {
    await purge();
    await raw.$disconnect();
    await appRole.$disconnect();
    await prisma.$disconnect();
  });

  it('a location created by Prisma gets a Monday–Friday calendar', async () => {
    expect(await calendarOf(locationA)).toEqual([MONDAY_TO_FRIDAY]);
  });

  it('a location inserted without the API (old replica) gets a Monday–Friday calendar', async () => {
    const id = await g1LocationInsert(
      raw,
      tenantA,
      'Sede de réplica antigua',
      REGIONAL_BERLIN_FIXTURE,
    );
    expect(await calendarOf(id)).toEqual([MONDAY_TO_FRIDAY]);
  });

  it('default calendar trigger works as dentalix_app under runWithTenant', async () => {
    const created = await prisma.runWithTenant(tenantA, (tx) =>
      tx.location.create({
        data: locationData(REGIONAL_TOKYO_FIXTURE, {
          tenantId: tenantA,
          name: 'Sede de la app',
        }),
      }),
    );
    expect(await calendarOf(created.id)).toEqual([MONDAY_TO_FRIDAY]);
    const [row] = await raw.$queryRaw<{ tenantId: string }[]>`
      SELECT "tenantId"::text AS "tenantId" FROM "location_working_calendars"
       WHERE "locationId" = ${created.id}::uuid`;
    expect(row.tenantId).toBe(tenantA);
  });

  it('without app.current_tenant, the app cannot create a location (and no calendar row is written anywhere)', async () => {
    const before = await raw.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "location_working_calendars"`;
    await expect(
      appRole.$executeRaw`
        INSERT INTO "locations" ("id", "tenantId", "name", "countryCode", "updatedAt")
        VALUES (gen_random_uuid(), ${tenantA}::uuid, 'Sin GUC',
                ${REGIONAL_TOKYO_FIXTURE.country}, now())`,
    ).rejects.toThrow(RLS_VIOLATION);
    const after = await raw.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "location_working_calendars"`;
    expect(after[0].n).toBe(before[0].n);
  });

  it('deleting a location (test cleanup) removes its calendar row', async () => {
    const id = await g1LocationInsert(
      raw,
      tenantA,
      'Sede que se borra',
      REGIONAL_TOKYO_FIXTURE,
    );
    expect(await calendarOf(id)).toHaveLength(1);
    await raw.location.delete({ where: { id } });
    expect(await calendarOf(id)).toEqual([]);
  });

  it('deleting a clinic removes the calendar and holidays of its locations (tenant FK CASCADE)', async () => {
    // Como location_reminder_settings: es configuración de la sede. Con
    // RESTRICT, `tenant.deleteMany` de las limpiezas e2e fallaba por la fila
    // que el trigger crea en cada sede.
    const tenantC = (
      await raw.tenant.create({
        data: { name: 'Clínica DX-316 C', subdomain: SUBDOMAINS[2] },
      })
    ).id;
    const id = await g1LocationInsert(
      raw,
      tenantC,
      'Sede de la clínica que se borra',
      REGIONAL_TOKYO_FIXTURE,
    );
    await insertHoliday('2027-01-04', 'Cierre anual', false, tenantC, id);
    expect(await calendarOf(id)).toHaveLength(1);

    await raw.tenant.delete({ where: { id: tenantC } });

    expect(await calendarOf(id)).toEqual([]);
    const holidays = await raw.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "location_holidays" WHERE "tenantId" = ${tenantC}::uuid`;
    expect(Number(holidays[0].n)).toBe(0);
    // `locations` no tiene FK al tenant: la sede huérfana se borra a mano.
    await raw.$executeRaw`DELETE FROM "locations" WHERE "id" = ${id}::uuid`;
  });

  it('a location with holidays cannot be hard-deleted', async () => {
    const id = await g1LocationInsert(
      raw,
      tenantA,
      'Sede con festivo',
      REGIONAL_TOKYO_FIXTURE,
    );
    await insertHoliday('2027-01-04', 'Cierre anual', false, tenantA, id);
    await expect(
      raw.$executeRaw`DELETE FROM "locations" WHERE "id" = ${id}::uuid`,
    ).rejects.toThrow(FK_VIOLATION);
    await raw.$executeRaw`
      DELETE FROM "location_holidays" WHERE "locationId" = ${id}::uuid`;
    await raw.$executeRaw`DELETE FROM "locations" WHERE "id" = ${id}::uuid`;
  });

  it('working weekdays check rejects empty, out of range, NULL and 2-D arrays', async () => {
    const set = (literal: string) =>
      raw.$executeRawUnsafe(
        `UPDATE "location_working_calendars"
            SET "workingWeekdays" = '${literal}'::smallint[]
          WHERE "locationId" = '${locationA}'`,
      );
    for (const bad of ['{}', '{7}', '{1,NULL}', '{{1,2},{3,4}}']) {
      await expect(set(bad)).rejects.toThrow(CHECK_VIOLATION);
    }
    try {
      // Domingo a jueves y los siete días valen.
      await expect(set('{0,1,2,3,4}')).resolves.toBe(1);
      await expect(set('{0,1,2,3,4,5,6}')).resolves.toBe(1);
    } finally {
      await set('{1,2,3,4,5}');
    }
  });

  it('holiday checks', async () => {
    await expect(
      insertHoliday('2099-12-31', 'Festivo de prueba 01'),
    ).resolves.toBe(1);
    await expect(
      insertHoliday('2101-01-01', 'Festivo de prueba 02'),
    ).rejects.toThrow(CHECK_VIOLATION);
    await expect(
      insertHoliday('1999-12-31', 'Festivo de prueba 03'),
    ).rejects.toThrow(CHECK_VIOLATION);
    await expect(insertHoliday('2027-06-01', ' x')).rejects.toThrow(
      CHECK_VIOLATION,
    );
    await expect(insertHoliday('2027-06-02', '')).rejects.toThrow(
      CHECK_VIOLATION,
    );
    await expect(insertHoliday('2027-06-03', 'a\tb')).rejects.toThrow(
      CHECK_VIOLATION,
    );
    await expect(insertHoliday('2027-06-04', 'x'.repeat(121))).rejects.toThrow(
      CHECK_VIOLATION,
    );
    await expect(insertHoliday('2028-02-29', 'Bisiesto', true)).rejects.toThrow(
      CHECK_VIOLATION,
    );
    await expect(insertHoliday('2028-02-29', 'Bisiesto')).resolves.toBe(1);
  });

  it('one-off unique per date among live rows; recurring unique per month-day across years', async () => {
    await insertHoliday('2027-05-03', 'Cierre anual');
    await expect(insertHoliday('2027-05-03', 'Otro nombre')).rejects.toThrow(
      UNIQUE_VIOLATION,
    );
    await insertHoliday('2020-05-03', 'Recurrente', true);
    await expect(
      insertHoliday('2027-05-03', 'Recurrente 2', true),
    ).rejects.toThrow(UNIQUE_VIOLATION);
    // Otra sede (de otra clínica) puede tener la misma fecha.
    await expect(
      insertHoliday('2027-05-03', 'Cierre anual', false, tenantB, locationB),
    ).resolves.toBe(1);
    // Retirado en blando, la fecha queda libre para una fila nueva.
    await raw.$executeRaw`
      UPDATE "location_holidays" SET "deletedAt" = now()
       WHERE "locationId" = ${locationA}::uuid AND NOT "recurring"
         AND "date" = '2027-05-03'::date`;
    await expect(insertHoliday('2027-05-03', 'Cierre anual')).resolves.toBe(1);
    await raw.$executeRaw`
      UPDATE "location_holidays" SET "deletedAt" = now()
       WHERE "locationId" = ${locationA}::uuid AND "recurring"`;
    await expect(
      insertHoliday('2031-05-03', 'Recurrente 3', true),
    ).resolves.toBe(1);
  });

  it("holiday cannot point at another clinic's location", async () => {
    await expect(
      insertHoliday(
        '2027-07-01',
        'Festivo de prueba 04',
        false,
        tenantA,
        locationB,
      ),
    ).rejects.toThrow(FK_VIOLATION);
  });

  it('createdAt is set by the server in UTC', async () => {
    await raw.$executeRaw`
      INSERT INTO "location_holidays"
        ("id", "tenantId", "locationId", "date", "name", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantA}::uuid, ${locationA}::uuid,
              '2027-08-01'::date, 'Festivo de prueba 05',
              '2000-01-01 00:00:00', now())`;
    const [holiday] = await raw.$queryRaw<{ drift: number }[]>`
      SELECT abs(extract(epoch FROM "createdAt" - timezone('UTC', now())))::float8 AS drift
        FROM "location_holidays"
       WHERE "locationId" = ${locationA}::uuid AND "date" = '2027-08-01'::date`;
    expect(holiday.drift).toBeLessThan(60);
    const id = await g1LocationInsert(
      raw,
      tenantA,
      'Sede para la hora de alta',
      REGIONAL_TOKYO_FIXTURE,
    );
    const [calendar] = await raw.$queryRaw<{ drift: number }[]>`
      SELECT abs(extract(epoch FROM "createdAt" - timezone('UTC', now())))::float8 AS drift
        FROM "location_working_calendars" WHERE "locationId" = ${id}::uuid`;
    expect(calendar.drift).toBeLessThan(60);
  });
});
