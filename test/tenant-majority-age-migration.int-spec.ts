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
import {
  MAJORITY_AGE_MAX,
  MAJORITY_AGE_MIN,
  PLATFORM_DEFAULT_MAJORITY_AGE,
} from '../src/modules/patients/domain/responsible-parties/majority-age';

// DX-328: la mayoría de edad pasa a ser de la clínica. Una BD desechable
// recibe todas las migraciones ANTERIORES y clínicas con sedes como las que
// hay hoy (las sedes llevan el país que hasta ahora decidía la edad); se
// aplican las cuatro migraciones y se comprueba que cada clínica conserva la
// edad que ya le aplicaba la app, que la columna nace con el default de
// plataforma y su CHECK, que FORCE vuelve a `locations` y que la columna y
// el relleno van en migraciones distintas (pre-flight I1).

const DX328 = '20261028160000_dx328_enums';
const COLUMN = '20261028160200_dx328_tenant_majority_age';
const BACKFILL = '20261028160300_dx328_tenant_majority_age_backfill';
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

const T_CO = '00000000-0000-4000-8000-0000000328a1';
const T_ES = '00000000-0000-4000-8000-0000000328b1';
const T_MIX = '00000000-0000-4000-8000-0000000328c1';
const T_RET = '00000000-0000-4000-8000-0000000328d1';
const T_NONE = '00000000-0000-4000-8000-0000000328e1';

const location = (
  tenant: string,
  name: string,
  country: 'CO' | 'ES',
  retired = false,
): string =>
  `(gen_random_uuid(), '${tenant}', '${name}', '${country}', 'EUR',
    'Europe/Berlin', 'de-DE', 'h23', ${retired ? 'now()' : 'NULL'}, now())`;

// Clínicas como las deja G1-B, antes de DX-328.
const SEED = [
  `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
   VALUES ('${T_CO}', 'Clínica CO', 'dx328-co', now()),
          ('${T_ES}', 'Clínica ES', 'dx328-es', now()),
          ('${T_MIX}', 'Clínica mixta', 'dx328-mix', now()),
          ('${T_RET}', 'Clínica retirada', 'dx328-ret', now()),
          ('${T_NONE}', 'Clínica sin sedes', 'dx328-none', now())`,
  `INSERT INTO "locations" ("id", "tenantId", "name", "country", "currency",
                            "timeZone", "locale", "hourCycle", "deletedAt",
                            "updatedAt")
   VALUES ${[
     location(T_CO, 'Sede 1', 'CO'),
     location(T_CO, 'Sede 2', 'CO'),
     location(T_ES, 'Sede 1', 'ES'),
     location(T_MIX, 'Sede 1', 'CO'),
     location(T_MIX, 'Sede 2', 'ES'),
     location(T_RET, 'Sede cerrada', 'ES', true),
   ].join(',\n')}`,
];

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

/** Tablas que el SQL altera con ALTER TABLE. */
function alteredTables(sql: string): string[] {
  return [...sql.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?"?(\w+)"?/gi)].map(
    (m) => m[1],
  );
}

describe('DX-328 · migraciones de la mayoría de edad por clínica (int)', () => {
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let db: string;
  let dir: string;
  let target: PrismaClient;

  beforeAll(async () => {
    db = `dx328_mig_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'dx328-'));
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
    for (const name of all.filter((n) => n < DX328)) copy(name);
    migrateDeploy(dir, urlFor(db));
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    for (const sql of SEED) await target.$executeRawUnsafe(sql);
    for (const name of all.filter((n) => n >= DX328)) copy(name);
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

  async function age(tenant: string): Promise<number> {
    const [row] = await target.$queryRaw<{ age: number }[]>`
      SELECT "majorityAge" AS age FROM "tenants" WHERE "id" = ${tenant}::uuid`;
    return row.age;
  }

  it('CO-only clinic → 18, ES-only → 16, mixed → 18, retired ES-only location counts, clinic without locations → 18', async () => {
    expect({
      co: await age(T_CO),
      es: await age(T_ES),
      mixed: await age(T_MIX),
      retired: await age(T_RET),
      none: await age(T_NONE),
    }).toEqual({ co: 18, es: 16, mixed: 18, retired: 16, none: 18 });
  });

  it('migration: every column default equals PLATFORM_DEFAULT_MAJORITY_AGE', async () => {
    const rows = await target.$queryRaw<
      { table: string; nullable: string; columnDefault: string | null }[]
    >`
      SELECT table_name AS table, is_nullable AS nullable,
             column_default AS "columnDefault"
        FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'majorityAge'`;
    expect(rows.map((r) => r.table)).toEqual(['tenants']);
    for (const { nullable, columnDefault } of rows) {
      expect(nullable).toBe('NO');
      expect(Number(columnDefault)).toBe(PLATFORM_DEFAULT_MAJORITY_AGE);
    }
  });

  it('CHECK rejects 13 and 22', async () => {
    const set = (value: number) =>
      target.$executeRawUnsafe(
        `UPDATE "tenants" SET "majorityAge" = ${value} WHERE "id" = '${T_NONE}'`,
      );
    await expect(set(MAJORITY_AGE_MIN - 1)).rejects.toThrow(
      /tenants_majority_age_check/,
    );
    await expect(set(MAJORITY_AGE_MAX + 1)).rejects.toThrow(
      /tenants_majority_age_check/,
    );
    try {
      await expect(set(MAJORITY_AGE_MIN)).resolves.toBe(1);
      await expect(set(MAJORITY_AGE_MAX)).resolves.toBe(1);
    } finally {
      await set(PLATFORM_DEFAULT_MAJORITY_AGE);
    }
  });

  it('a tenant INSERT that does not name majorityAge gets PLATFORM_DEFAULT_MAJORITY_AGE', async () => {
    // Lo que envía el cliente Prisma de una réplica anterior a DX-328.
    const [row] = await target.$queryRaw<{ age: number }[]>`
      INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
      VALUES (gen_random_uuid(), 'Réplica antigua', 'dx328-old', now())
      RETURNING "majorityAge" AS age`;
    expect(row.age).toBe(PLATFORM_DEFAULT_MAJORITY_AGE);
  });

  it('locations is FORCE ROW LEVEL SECURITY again after the backfill', async () => {
    const [row] = await target.$queryRaw<{ forced: boolean }[]>`
      SELECT relforcerowsecurity AS forced FROM pg_class
       WHERE oid = 'public.locations'::regclass`;
    expect(row.forced).toBe(true);
  });

  it('the column migration only alters tenants and the backfill migration does not ALTER tenants', () => {
    // Pre-flight I1: la migración que toma ACCESS EXCLUSIVE en `tenants` no
    // espera después el de `locations` en la misma transacción.
    expect(alteredTables(migrationSql(COLUMN))).toEqual(['tenants']);
    const backfill = alteredTables(migrationSql(BACKFILL));
    expect(backfill).not.toContain('tenants');
    expect(backfill).toEqual(['locations', 'locations']);
  });

  it('CLINIC_SETTINGS is a value of AuditResourceType and its partial index exists', async () => {
    const [value] = await target.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'AuditResourceType' AND e.enumlabel = 'CLINIC_SETTINGS'`;
    expect(value.n).toBe(1);
    const [index] = await target.$queryRaw<{ def: string }[]>`
      SELECT indexdef AS def FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'audit_events_resource_clinic_settings_idx'`;
    expect(index.def).toContain(`'CLINIC_SETTINGS'`);
  });
});
