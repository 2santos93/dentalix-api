import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';

// DX-329: prefijo telefónico por defecto de la sede ("defaultPhoneRegion") y
// la marca de quién lo decidió ("defaultPhoneRegionSetAt"). Una BD
// desechable, sin `db seed`, recibe todas las migraciones ANTERIORES y dos
// clínicas con sedes de países distintos (una borrada en blando); después
// M1 y M2. Se comprueba que el relleno da a cada sede su país sin tocar
// `updatedAt` ni la marca, que una sede nueva sin el campo queda sin
// prefijo, el CHECK, que M2 es idempotente, y que ni M2 ni el relleno del
// runbook (spec §10.4) pisan una región que decidió un ADMIN, también si la
// vació (pre-flight I9).

const DX329 = '20261103120400_dx329_location_default_phone_region';
const DX329_M2 = '20261103120500_dx329_location_default_phone_region_backfill';
const ROOT = join(__dirname, '..');

// El relleno del runbook (spec §10.4), copiado tal cual.
const REFILL = `UPDATE "locations" SET "defaultPhoneRegion" = "countryCode"
 WHERE "defaultPhoneRegion" IS NULL
   AND "defaultPhoneRegionSetAt" IS NULL`;

function urlFor(db: string): string {
  const url = new URL(process.env.DIRECT_URL as string);
  url.pathname = `/${db}`;
  return url.toString();
}

/** psql no acepta el `?schema=public` de las URL de Prisma. */
function psqlUrl(db: string): string {
  const url = new URL(urlFor(db));
  url.search = '';
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

/** M2 otra vez, como la lanzaría el DBA: sin `-1` (sus COMMIT van en el DO). */
function rerunBackfill(db: string): void {
  try {
    execFileSync(
      'psql',
      [
        psqlUrl(db),
        '-X',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        join(ROOT, 'prisma/migrations', DX329_M2, 'migration.sql'),
      ],
      { stdio: 'pipe' },
    );
  } catch (err) {
    const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `psql falló:\n${String(stdout ?? '')}${String(stderr ?? '')}`,
    );
  }
}

const T_A = '00000000-0000-4000-8000-000000329a00';
const T_B = '00000000-0000-4000-8000-000000329b00';
const id = (tenant: string, n: number): string =>
  `${tenant.slice(0, -2)}${n.toString(16).padStart(2, '0')}`;
const L_A = id(T_A, 0x10);
const L_A_DELETED = id(T_A, 0x11);
const L_B = id(T_B, 0x10);
const SEEDED = [L_A, L_A_DELETED, L_B];
const UPDATED_AT = '2026-10-01T10:00:00.000Z';

// Clínicas como las deja DX-312: cada sede con su país y sin prefijo.
const SEED = [
  `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
   VALUES ('${T_A}', 'Clínica A', 'dx329-a', now()),
          ('${T_B}', 'Clínica B', 'dx329-b', now())`,
  `INSERT INTO "locations" ("id", "tenantId", "name", "countryCode",
                            "deletedAt", "updatedAt")
   VALUES ('${L_A}', '${T_A}', 'Sede viva', 'VE', NULL, '${UPDATED_AT}'),
          ('${L_A_DELETED}', '${T_A}', 'Sede borrada', 'JP', now(), '${UPDATED_AT}'),
          ('${L_B}', '${T_B}', 'Sede B', 'DE', NULL, '${UPDATED_AT}')`,
];

interface Row {
  id: string;
  country: string;
  region: string | null;
  setAt: string | null;
  updatedAt: string;
}

describe('DX-329 · migraciones del prefijo telefónico de la sede (int)', () => {
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let db: string;
  let dir: string;
  let target: PrismaClient;

  const ts = (column: string): string =>
    `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

  async function rows(ids: string[] = SEEDED): Promise<Row[]> {
    return target.$queryRawUnsafe<Row[]>(
      `SELECT "id"::text AS id, "countryCode"::text AS country,
              "defaultPhoneRegion"::text AS region,
              ${ts('"defaultPhoneRegionSetAt"')} AS "setAt",
              ${ts('"updatedAt"')} AS "updatedAt"
         FROM "locations" WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`,
      ids,
    );
  }

  let seq = 0x40;
  /** Sede nueva por SQL, sin las columnas de DX-329 (réplica anterior). */
  async function insertLocation(
    tenant: string,
    country: string,
  ): Promise<string> {
    const rowId = id(tenant, seq++);
    await target.$executeRawUnsafe(
      `INSERT INTO "locations" ("id", "tenantId", "name", "countryCode", "updatedAt")
       VALUES ('${rowId}', '${tenant}', 'Sede ${seq}', '${country}', '${UPDATED_AT}')`,
    );
    return rowId;
  }

  beforeAll(async () => {
    db = `dx329_mig_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'dx329-'));
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
    for (const name of all.filter((n) => n < DX329)) copy(name);
    migrateDeploy(dir, urlFor(db));
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    for (const sql of SEED) await target.$executeRawUnsafe(sql);
    for (const name of all.filter((n) => n >= DX329)) copy(name);
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

  it('existing locations get their country as default phone region after the DX-329 migrations', async () => {
    expect(await rows()).toEqual(
      [
        { id: L_A, country: 'VE' },
        { id: L_A_DELETED, country: 'JP' },
        { id: L_B, country: 'DE' },
      ]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((r) => ({
          ...r,
          region: r.country,
          setAt: null,
          updatedAt: UPDATED_AT,
        })),
    );
  });

  it('M2 does not set the decision mark', async () => {
    const [row] = await target.$queryRaw<{ filled: number; marked: number }[]>`
      SELECT count(*) FILTER (WHERE "defaultPhoneRegion" IS NOT NULL)::int AS filled,
             count(*) FILTER (WHERE "defaultPhoneRegionSetAt" IS NOT NULL)::int AS marked
        FROM "locations"`;
    expect(row).toEqual({ filled: SEEDED.length, marked: 0 });
  });

  it('a location created after M1 without the field has no default phone region', async () => {
    const created = await insertLocation(T_A, 'VE');
    expect(await rows([created])).toEqual([
      {
        id: created,
        country: 'VE',
        region: null,
        setAt: null,
        updatedAt: UPDATED_AT,
      },
    ]);
    const [col] = await target.$queryRaw<{ dflt: string | null }[]>`
      SELECT string_agg(coalesce(column_default, '-'), ',' ORDER BY column_name) AS dflt
        FROM information_schema.columns
       WHERE table_name = 'locations'
         AND column_name IN ('defaultPhoneRegion', 'defaultPhoneRegionSetAt')`;
    expect(col.dflt).toBe('-,-');
  });

  it('the default phone region check refuses anything but two capital letters', async () => {
    const location = await insertLocation(T_B, 'DE');
    for (const value of ['ve', 'V1', 'V', '1A']) {
      await expect(
        target.$executeRawUnsafe(
          `UPDATE "locations" SET "defaultPhoneRegion" = $1 WHERE "id" = $2::uuid`,
          value,
          location,
        ),
      ).rejects.toThrow(/23514[\s\S]*locations_default_phone_region_check/);
    }
    // Tres letras ni siquiera caben en CHAR(2).
    await expect(
      target.$executeRawUnsafe(
        `UPDATE "locations" SET "defaultPhoneRegion" = 'VEN' WHERE "id" = $1::uuid`,
        location,
      ),
    ).rejects.toThrow(/22001/);
    await target.$executeRawUnsafe(
      `UPDATE "locations" SET "defaultPhoneRegion" = 'AC' WHERE "id" = $1::uuid`,
      location,
    );
    await target.$executeRawUnsafe(
      `UPDATE "locations" SET "defaultPhoneRegion" = NULL WHERE "id" = $1::uuid`,
      location,
    );
  });

  it('the backfill is idempotent and keeps a region an admin changed', async () => {
    // Un ADMIN eligió otra región para la sede viva de A.
    await target.$executeRawUnsafe(
      `UPDATE "locations" SET "defaultPhoneRegion" = 'CO',
              "defaultPhoneRegionSetAt" = now()
        WHERE "id" = $1::uuid`,
      L_A,
    );
    // Una réplica anterior cambió el país de la sede borrada después del
    // relleno: su región, sin marca, ya no se deduce del país.
    await target.$executeRawUnsafe(
      `UPDATE "locations" SET "countryCode" = 'CO' WHERE "id" = $1::uuid`,
      L_A_DELETED,
    );
    const all = (
      await target.$queryRaw<{ id: string }[]>`
        SELECT "id"::text AS id FROM "locations"`
    ).map((r) => r.id);
    const before = await rows(all);
    expect(before.find((r) => r.id === L_A)?.region).toBe('CO');
    expect(before.find((r) => r.id === L_A_DELETED)).toMatchObject({
      country: 'CO',
      region: 'JP',
    });
    rerunBackfill(db);
    const once = await rows(all);
    rerunBackfill(db);
    const twice = await rows(all);
    // La primera vez solo rellena las sedes sin decidir que dejaron los
    // casos anteriores; la segunda, nada.
    for (const kept of [L_A, L_A_DELETED]) {
      expect(once.find((r) => r.id === kept)).toEqual(
        before.find((r) => r.id === kept),
      );
    }
    expect(twice).toEqual(once);
  });

  it('the refill never overwrites a region an admin cleared', async () => {
    // Un ADMIN vació el prefijo de la sede B con la API nueva (marca puesta);
    // una réplica anterior creó otra sede en B sin las columnas.
    await target.$executeRawUnsafe(
      `UPDATE "locations" SET "defaultPhoneRegion" = NULL,
              "defaultPhoneRegionSetAt" = now()
        WHERE "id" = $1::uuid`,
      L_B,
    );
    const replica = await insertLocation(T_B, 'DE');
    const [cleared] = await rows([L_B]);
    expect(cleared.region).toBeNull();
    expect(cleared.setAt).not.toBeNull();
    // El relleno del runbook, en una transacción, como el DBA.
    await target.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(REFILL);
    });
    expect(await rows([L_B])).toEqual([cleared]);
    expect((await rows([replica]))[0]).toMatchObject({
      region: 'DE',
      setAt: null,
    });
    // M2 tampoco la pisa.
    rerunBackfill(db);
    expect(await rows([L_B])).toEqual([cleared]);
  });
});
