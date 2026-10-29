// Excepción G5.3 (DX-334): país de sede anterior a DX-312.
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
import { ISO3166_COUNTRIES } from '../prisma/reference/iso3166';
import { legacyClinicCountry } from '../src/shared/locations/legacy-clinic-country';
import {
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
} from './support/location-fixtures';

// DX-312 (fase 1): el país de la sede va en una columna propia
// ("countryCode", FK a countries) y la antigua ("country", enum) se queda,
// mantenida por el trigger locations_country_code para las réplicas
// anteriores. Una BD desechable, sin `db seed`, recibe todas las migraciones
// ANTERIORES y dos clínicas con sedes de los dos países del enum (una
// borrada, una sin datos regionales), recetas legada y única y pendientes;
// después las cuatro migraciones de DX-312, de una en una, cuando el caso lo
// pide (la ventana M1→M2 y el estado antes de M4). Se comprueba que ninguna
// sede cambia de país, cada caso del trigger (spec §3.3), las recetas, la
// validación de M3 y la forma de las migraciones. Solo SQL; los INSERT del
// escritor anterior copian la lista de columnas que emite su cliente de
// Prisma (log de la sonda de T3, ledger de DX-312).

const DX312 = '20261031120000_dx312_location_country_code';
const DX312_M2 = '20261031120100_dx312_location_country_code_backfill';
const DX312_M3 = '20261031120200_dx312_location_country_code_validate';
const DX312_M4 = '20261031120300_dx312_location_country_drop_default';
const DX312_MIGRATIONS = [DX312, DX312_M2, DX312_M3, DX312_M4];
const ROOT = join(__dirname, '..');
const LEGACY_REGISTRATION_ERROR =
  /DX-312: una sede necesita país y datos regionales; el registro sin sede ya no se admite\./;

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

/** psql con ON_ERROR_STOP; si falla, el error lleva su salida. */
function psql(db: string, args: string[]): void {
  try {
    execFileSync(
      'psql',
      [psqlUrl(db), '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args],
      { stdio: 'pipe' },
    );
  } catch (err) {
    const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `psql falló:\n${String(stdout ?? '')}${String(stderr ?? '')}`,
    );
  }
}

const migrationPath = (name: string): string =>
  join(ROOT, 'prisma/migrations', name, 'migration.sql');

const migrationSql = (name: string): string =>
  readFileSync(migrationPath(name), 'utf8');

/** Las sentencias de una migración, sin comentarios (un DO es una sola). */
function statements(name: string): string[] {
  const sql = migrationSql(name)
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  const out: string[] = [];
  let rest = sql;
  while (rest.trim()) {
    const dollar = rest.indexOf('$$');
    const semi = rest.indexOf(';');
    if (semi === -1) break;
    if (dollar !== -1 && dollar < semi) {
      const close = rest.indexOf('$$', dollar + 2);
      const end = rest.indexOf(';', close + 2);
      out.push(rest.slice(0, end));
      rest = rest.slice(end + 1);
    } else {
      out.push(rest.slice(0, semi));
      rest = rest.slice(semi + 1);
    }
  }
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const T_A = '00000000-0000-4000-8000-000000312a00';
const T_B = '00000000-0000-4000-8000-000000312b00';
const id = (tenant: string, n: number): string =>
  `${tenant.slice(0, -2)}${n.toString(16).padStart(2, '0')}`;
const U_DR = id(T_A, 0x01);
const P_A = id(T_A, 0x02);
const L_CO = id(T_A, 0x10);
const L_ES = id(T_A, 0x11);
const L_DELETED = id(T_A, 0x12);
// Sede de una réplica anterior a G1 (sin datos regionales, sin barrer).
const L_BARE = id(T_A, 0x13);
const L_WINDOW = id(T_A, 0x14);
const L_B_ES = id(T_B, 0x10);
const RX_LEGACY = id(T_A, 0x20);
const RX_SINGLE = id(T_A, 0x21);
const SEEDED_LOCATIONS = [L_CO, L_ES, L_DELETED, L_BARE, L_WINDOW, L_B_ES];

/** Datos regionales de una sede del segundo valor del enum (solo los legados). */
const LEGACY_ES_REGIONAL = {
  currency: 'EUR',
  timeZone: 'Europe/Madrid',
  locale: 'es-ES',
  hourCycle: 'h23',
};

const lit = (text: string): string => `'${text.replace(/'/g, "''")}'`;

const regional = (r: {
  currency: string;
  timeZone: string;
  locale: string;
  hourCycle: string;
}): string =>
  [r.currency, r.timeZone, r.locale, r.hourCycle].map(lit).join(', ');

const legacyRx = (rxId: string, country: string): string =>
  `('${rxId}', '${T_A}', '${L_CO}', '${P_A}', '${U_DR}', '${country}', false, NULL,
    now(), '2026-10-28', '2026-11-26', 'Paciente', 'HC-1', 'Dra. Prueba',
    'RM-1', 'Clínica A', 'Sede', '2026-10-24', '[]'::jsonb, '${'c'.repeat(64)}')`;

// Clínicas como las deja DX-327, antes de DX-312.
const SEED = [
  `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
   VALUES ('${T_A}', 'Clínica A', 'dx312-a', now()),
          ('${T_B}', 'Clínica B', 'dx312-b', now())`,
  `INSERT INTO "users" ("id", "email", "passwordHash", "fullName", "updatedAt")
   VALUES ('${U_DR}', 'dr@dx312.test', 'x', 'Dra. Prueba', now())`,
  `INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName", "updatedAt")
   VALUES ('${P_A}', '${T_A}', 'Pía', 'Arias', now())`,
  `INSERT INTO "locations" ("id", "tenantId", "name", "country", "currency",
                            "timeZone", "locale", "hourCycle", "deletedAt",
                            "updatedAt")
   VALUES ('${L_CO}', '${T_A}', 'Sede 1', 'CO', ${regional(REGIONAL_BOGOTA_FIXTURE)}, NULL, now()),
          ('${L_ES}', '${T_A}', 'Sede 2', 'ES', ${regional(LEGACY_ES_REGIONAL)}, NULL, now()),
          ('${L_DELETED}', '${T_A}', 'Sede 3', 'CO', ${regional(REGIONAL_BOGOTA_FIXTURE)}, now(), now()),
          ('${L_WINDOW}', '${T_A}', 'Sede 5', 'CO', ${regional(REGIONAL_BOGOTA_FIXTURE)}, NULL, now()),
          ('${L_B_ES}', '${T_B}', 'Sede 1', 'ES', ${regional(LEGACY_ES_REGIONAL)}, NULL, now())`,
  `INSERT INTO "locations" ("id", "tenantId", "name", "country", "updatedAt")
   VALUES ('${L_BARE}', '${T_A}', 'Sede 4', 'CO', now())`,
  `INSERT INTO "prescriptions" ("id", "tenantId", "locationId", "patientId",
       "professionalId", "country", "singleFormat", "printQuantityInWords",
       "issuedAt", "dispensationDate", "validUntil", "patientName",
       "clinicalRecordNumber", "professionalName", "professionalLicense",
       "clinicName", "locationName", "safetyRulesVersion", "safetyAlerts",
       "contentHash")
   VALUES ${legacyRx(RX_LEGACY, 'CO')},
          ('${RX_SINGLE}', '${T_A}', '${L_CO}', '${P_A}', '${U_DR}', 'ES', true,
           false, now(), '2026-10-28', '2026-11-26', 'Paciente', NULL,
           'Dra. Prueba', 'RM-1', 'Clínica A', 'Sede', '2026-10-24',
           '[]'::jsonb, '${'d'.repeat(64)}')`,
  `INSERT INTO "pending_registrations" ("id", "email", "clinicName",
       "subdomain", "fullName", "passwordHash", "tokenHash", "expiresAt",
       "locationCountry", "locationCurrency", "locationTimeZone",
       "locationLocale")
   VALUES (gen_random_uuid(), 'co@dx312.test', 'Pend 1', 'dx312-p1', 'P', 'x',
           '${'1'.repeat(64)}', now() + interval '1 day', 'CO', 'COP', 'America/Bogota', 'es-CO'),
          (gen_random_uuid(), 'es@dx312.test', 'Pend 2', 'dx312-p2', 'P', 'x',
           '${'2'.repeat(64)}', now() + interval '1 day', 'ES', 'EUR', 'Europe/Madrid', 'es-ES'),
          (gen_random_uuid(), 'none@dx312.test', 'Pend 3', 'dx312-p3', 'P', 'x',
           '${'3'.repeat(64)}', now() + interval '1 day', NULL, NULL, NULL, NULL)`,
];

interface CountryRow {
  id: string;
  tenantId: string;
  country: string | null;
}

const SNAPSHOT = `
  SELECT "id"::text AS id, "tenantId"::text AS "tenantId",
         "country"::text AS country
    FROM "locations" ORDER BY "id"`;

interface Pair {
  country: string | null;
  countryCode: string | null;
}

// Columnas que emite el cliente de Prisma de la API anterior (9e958abd), del
// log de la sonda: alta de sede (prisma-location.repository.ts:34-46) y
// registro con sede (prisma-auth.repository.ts:148-155) mandan las mismas; el
// registro legado (:162-165), solo las que su cliente rellena con @default.
const OLD_LOCATION_COLUMNS = [
  'id',
  'tenantId',
  'name',
  'country',
  'currency',
  'timeZone',
  'locale',
  'regionalSettingsReviewedAt',
  'hourCycle',
  'showHealthRegistrationNumber',
  'isActive',
  'createdAt',
  'updatedAt',
];
const OLD_LEGACY_REGISTRATION_COLUMNS = [
  'id',
  'tenantId',
  'name',
  'country',
  'showHealthRegistrationNumber',
  'isActive',
  'createdAt',
  'updatedAt',
];
// Lo que emite el cliente nuevo: "countryCode" (@map) y nunca "country"
// (@ignore).
const NEW_LOCATION_COLUMNS = OLD_LOCATION_COLUMNS.map((c) =>
  c === 'country' ? 'countryCode' : c,
);

describe('DX-312 · migraciones del país ISO de la sede (int)', () => {
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let db: string;
  let namesDb: string;
  let checkDb: string;
  let dir: string;
  let target: PrismaClient;
  let before: CountryRow[];
  let all: string[];
  let stage = '';

  /** Aplica, con `prisma migrate deploy`, las migraciones hasta `name` incluida. */
  function reach(name: string): void {
    if (name < stage) throw new Error(`${name} ya quedó atrás (${stage})`);
    if (name === stage) return;
    for (const n of all.filter((m) => m <= name && m > stage)) {
      cpSync(join(ROOT, 'prisma/migrations', n), join(dir, 'migrations', n), {
        recursive: true,
      });
    }
    migrateDeploy(dir, urlFor(db));
    stage = name;
  }

  /** Como la app: dentalix_app con la clínica fijada (RLS FORCE). */
  async function asApp<T = unknown>(
    tenant: string,
    sql: string,
    ...params: unknown[]
  ): Promise<T[]> {
    return target.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE dentalix_app');
      await tx.$queryRawUnsafe(
        `SELECT set_config('app.current_tenant', $1, true)`,
        tenant,
      );
      return tx.$queryRawUnsafe<T[]>(sql, ...params);
    });
  }

  async function pairOf(locationId: string): Promise<Pair> {
    const [row] = await target.$queryRawUnsafe<Pair[]>(
      `SELECT "country"::text AS country, "countryCode"::text AS "countryCode"
         FROM "locations" WHERE "id" = $1::uuid`,
      locationId,
    );
    return row;
  }

  let seq = 0x40;
  /** INSERT de una sede como la app; `values` va en el orden de `columns`. */
  async function insertLocation(
    tenant: string,
    columns: string[],
    values: Record<string, string>,
  ): Promise<string> {
    const rowId = id(tenant, seq++);
    const row: Record<string, string> = {
      id: `'${rowId}'`,
      tenantId: `'${tenant}'`,
      name: `'Sede ${seq}'`,
      showHealthRegistrationNumber: 'false',
      isActive: 'true',
      createdAt: 'now()',
      updatedAt: 'now()',
      regionalSettingsReviewedAt: 'now()',
      ...values,
    };
    await asApp(
      tenant,
      `INSERT INTO "locations" (${columns.map((c) => `"${c}"`).join(', ')})
       VALUES (${columns.map((c) => row[c]).join(', ')}) RETURNING "id"`,
    );
    return rowId;
  }

  /** Alta de sede o registro con sede de la API anterior. */
  const oldInsert = (tenant: string, country: 'CO' | 'ES'): Promise<string> =>
    insertLocation(tenant, OLD_LOCATION_COLUMNS, {
      country: `CAST('${country}'::text AS "public"."ClinicCountry")`,
      currency: country === 'CO' ? `'COP'` : `'EUR'`,
      timeZone: country === 'CO' ? `'America/Bogota'` : `'Europe/Madrid'`,
      locale: country === 'CO' ? `'es-CO'` : `'es-ES'`,
      hourCycle: `'h23'`,
    });

  /** Alta de la API nueva, con el país que se le pase. */
  const newInsert = (
    tenant: string,
    countryCode: string,
    r: {
      currency: string;
      timeZone: string;
      locale: string;
      hourCycle: string;
    },
  ): Promise<string> =>
    insertLocation(tenant, NEW_LOCATION_COLUMNS, {
      countryCode: lit(countryCode),
      currency: lit(r.currency),
      timeZone: lit(r.timeZone),
      locale: lit(r.locale),
      hourCycle: lit(r.hourCycle),
    });

  const VE_REGIONAL = {
    currency: 'VES',
    timeZone: 'America/Caracas',
    locale: 'es-VE',
    hourCycle: 'h12',
  };

  async function update(
    tenant: string,
    locationId: string,
    set: string,
  ): Promise<void> {
    await asApp(
      tenant,
      `UPDATE "locations" SET ${set}, "updatedAt" = now()
        WHERE "id" = $1::uuid RETURNING "id"`,
      locationId,
    );
  }

  async function columnDefault(column: string): Promise<string | null> {
    const [row] = await target.$queryRawUnsafe<{ dflt: string | null }[]>(
      `SELECT column_default AS dflt FROM information_schema.columns
        WHERE table_name = 'locations' AND column_name = $1`,
      column,
    );
    return row.dflt;
  }

  beforeAll(async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    db = `dx312_mig_${suffix}`;
    namesDb = `dx312_names_${suffix}`;
    checkDb = `dx312_check_${suffix}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'dx312-'));
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(
      join(ROOT, 'prisma/migrations/migration_lock.toml'),
      join(dir, 'migrations/migration_lock.toml'),
    );
    all = readdirSync(join(ROOT, 'prisma/migrations')).filter(
      (name) => !name.endsWith('.toml'),
    );
    for (const name of all.filter((n) => n < DX312)) {
      cpSync(
        join(ROOT, 'prisma/migrations', name),
        join(dir, 'migrations', name),
        { recursive: true },
      );
    }
    migrateDeploy(dir, urlFor(db));
    stage = all.filter((n) => n < DX312).pop() as string;
    // Copias de la base antes de DX-312, sin nadie conectado a ella.
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${namesDb}" TEMPLATE "${db}"`,
    );
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${checkDb}" TEMPLATE "${db}"`,
    );
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    // La base desechable no hereda los privilegios por defecto de la de test.
    await target.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dentalix_app`,
    );
    for (const sql of SEED) await target.$executeRawUnsafe(sql);
    before = await target.$queryRawUnsafe<CountryRow[]>(SNAPSHOT);
    reach(DX312);
  }, 300_000);

  afterAll(async () => {
    await target?.$disconnect();
    for (const name of [db, namesDb, checkDb]) {
      await admin.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
      );
    }
    rmSync(dir, { recursive: true, force: true });
    await admin.$disconnect();
  }, 60_000);

  it('countries holds exactly the generated list with Spanish names after migrate deploy', async () => {
    // AC2: la base solo corrió `migrate deploy` (nunca `db seed`).
    const rows = await target.$queryRaw<{ code: string; name: string }[]>`
      SELECT "code", "name" FROM "countries" ORDER BY "code" COLLATE "C"`;
    expect(rows).toEqual(
      ISO3166_COUNTRIES.map(({ code, name }) => ({ code, name })),
    );
  });

  it('M1 renames English country names to Spanish and keeps extra rows', async () => {
    // Una base que ya tenía `countries` sembrada (nombres en inglés) y una
    // fila propia con una ciudad.
    const names = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(namesDb) } },
    });
    try {
      await names.$executeRawUnsafe(
        `INSERT INTO "countries" ("code", "name")
         VALUES ('ES', 'Spain'), ('ZZ', 'Testland')`,
      );
      await names.$executeRawUnsafe(
        `INSERT INTO "cities" ("countryCode", "name") VALUES ('ZZ', 'Testville')`,
      );
      psql(namesDb, ['-1', '-f', migrationPath(DX312)]);
      const rows = await names.$queryRaw<{ code: string; name: string }[]>`
        SELECT "code", "name" FROM "countries"
         WHERE "code" IN ('ES', 'ZZ') ORDER BY "code"`;
      expect(rows).toEqual([
        {
          code: 'ES',
          name: ISO3166_COUNTRIES.find((c) => c.code === 'ES')?.name,
        },
        { code: 'ZZ', name: 'Testland' },
      ]);
      expect(rows[0].name).not.toBe('Spain');
      const [count] = await names.$queryRaw<{ n: number; cities: number }[]>`
        SELECT (SELECT count(*)::int FROM "countries") AS n,
               (SELECT count(*)::int FROM "cities" WHERE "countryCode" = 'ZZ') AS cities`;
      expect(count).toEqual({ n: ISO3166_COUNTRIES.length + 1, cities: 1 });
    } finally {
      await names.$disconnect();
    }
  });

  it('legacy: between M1 and M2 an old-API update of the name, a soft delete and the D5 function succeed', async () => {
    expect(stage).toBe(DX312);
    // PATCH de la API anterior (updateMany del nombre), borrado en blando y
    // el job D5 sobre la sede sin datos regionales: sin ningún CHECK sobre
    // "countryCode" hasta M3 (pre-flight I1).
    await update(T_A, L_CO, `"name" = 'Sede 1 renombrada'`);
    await update(T_A, L_WINDOW, `"deletedAt" = now()`);
    await asApp(
      T_A,
      `SELECT public.dx_g1_backfill_location_regional($1::uuid)`,
      T_A,
    );
    const [bare] = await target.$queryRaw<{ currency: string | null }[]>`
      SELECT "currency" FROM "locations" WHERE "id" = ${L_BARE}::uuid`;
    expect(bare.currency).toBe(REGIONAL_BOGOTA_FIXTURE.currency);
    for (const loc of [L_CO, L_WINDOW, L_BARE]) {
      expect(await pairOf(loc)).toEqual({ country: 'CO', countryCode: null });
    }
    reach(DX312_M2);
    for (const loc of [L_CO, L_WINDOW, L_BARE]) {
      expect(await pairOf(loc)).toEqual({ country: 'CO', countryCode: 'CO' });
    }
  });

  it('M3 fails on a location with no country, an unknown code or an incoherent pair', async () => {
    // Base aparte, con M1 y M2 y la FK ya validada (si no, su VALIDATE
    // saltaría antes que la comprobación por clínica). Cada fila mala entra
    // con los triggers desactivados (también los de la FK), y M3 se aplica
    // en una transacción que se deshace.
    psql(checkDb, ['-1', '-f', migrationPath(DX312)]);
    psql(checkDb, ['-f', migrationPath(DX312_M2)]);
    const check = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(checkDb) } },
    });
    try {
      await check.$executeRawUnsafe(
        `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
         VALUES ('${T_A}', 'Clínica A', 'dx312-a', now())`,
      );
      await check.$executeRawUnsafe(
        `ALTER TABLE "locations" VALIDATE CONSTRAINT "locations_country_code_fkey"`,
      );
      const cases: [string, string, RegExp][] = [
        ['NULL', `'CO'`, /DX-312: 1 sedes sin país en la clínica/],
        [
          `'ZZ'`,
          'NULL',
          /DX-312: 1 sedes con un país que no está en countries en la clínica/,
        ],
        [
          `'VE'`,
          `'CO'`,
          /DX-312: 1 sedes con la columna antigua del país incoherente en la clínica/,
        ],
      ];
      for (const [countryCode, country, error] of cases) {
        await check.$transaction([
          check.$executeRawUnsafe(
            `ALTER TABLE "locations" DISABLE TRIGGER ALL`,
          ),
          check.$executeRawUnsafe(
            `INSERT INTO "locations" ("id", "tenantId", "name", "country",
                 "countryCode", "currency", "timeZone", "locale", "updatedAt")
             VALUES (gen_random_uuid(), '${T_A}', 'Mala', ${country},
                     ${countryCode}, ${regional(REGIONAL_TOKYO_FIXTURE).split(', ').slice(0, 3).join(', ')}, now())`,
          ),
          check.$executeRawUnsafe(`ALTER TABLE "locations" ENABLE TRIGGER ALL`),
        ]);
        expect(() =>
          psql(checkDb, ['-1', '-f', migrationPath(DX312_M3)]),
        ).toThrow(error);
        await check.$executeRawUnsafe(
          `DELETE FROM "locations" WHERE "name" = 'Mala'`,
        );
      }
      // Un fallo DESPUÉS del NO FORCE (revisión final, M6): la FK vuelve a
      // NOT VALID, como la deja M1, y una sede huérfana (su clínica no está
      // en tenants, así que la comprobación por clínica no la ve) con un
      // código fuera de countries hace fallar el VALIDATE de la FK, que va
      // dentro del bracket. Con `psql -1` todo se deshace: FORCE sigue
      // puesto, la FK sin validar y "countryCode" nullable.
      await check.$transaction([
        check.$executeRawUnsafe(
          `ALTER TABLE "locations" DROP CONSTRAINT "locations_country_code_fkey"`,
        ),
        check.$executeRawUnsafe(
          `ALTER TABLE "locations" ADD CONSTRAINT "locations_country_code_fkey"
             FOREIGN KEY ("countryCode") REFERENCES "countries"("code")
             ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID`,
        ),
        check.$executeRawUnsafe(`ALTER TABLE "locations" DISABLE TRIGGER ALL`),
        check.$executeRawUnsafe(
          `INSERT INTO "locations" ("id", "tenantId", "name", "country",
               "countryCode", "currency", "timeZone", "locale", "updatedAt")
           VALUES (gen_random_uuid(), '${id(T_B, 0xee)}', 'Huérfana', NULL,
                   'ZZ', ${regional(REGIONAL_TOKYO_FIXTURE).split(', ').slice(0, 3).join(', ')}, now())`,
        ),
        check.$executeRawUnsafe(`ALTER TABLE "locations" ENABLE TRIGGER ALL`),
      ]);
      expect(() =>
        psql(checkDb, ['-1', '-f', migrationPath(DX312_M3)]),
      ).toThrow(
        /violates foreign key constraint "locations_country_code_fkey"/,
      );
      const [afterFailure] = await check.$queryRaw<
        { forced: boolean; validated: boolean; nullable: string }[]
      >`
        SELECT c.relforcerowsecurity AS forced,
               (SELECT convalidated FROM pg_constraint
                 WHERE conname = 'locations_country_code_fkey') AS validated,
               (SELECT is_nullable FROM information_schema.columns
                 WHERE table_name = 'locations'
                   AND column_name = 'countryCode') AS nullable
          FROM pg_class c WHERE c.oid = 'public.locations'::regclass`;
      expect(afterFailure).toEqual({
        forced: true,
        validated: false,
        nullable: 'YES',
      });
      await check.$executeRawUnsafe(
        `DELETE FROM "locations" WHERE "name" = 'Huérfana'`,
      );
      // Sin filas malas, M3 pasa.
      psql(checkDb, ['-1', '-f', migrationPath(DX312_M3)]);
    } finally {
      await check.$disconnect();
    }
  });

  // A partir de aquí, M1-M3 aplicadas y el valor por defecto de la columna
  // antigua aún puesto; M4 la aplica el caso de los datos regionales sin
  // país, y los que van detrás corren ya sin él. Cada caso pide su etapa
  // (`reach` solo avanza).

  it('legacy old-API insert CO fills countryCode', async () => {
    reach(DX312_M3);
    const loc = await oldInsert(T_A, 'CO');
    expect(await pairOf(loc)).toEqual({ country: 'CO', countryCode: 'CO' });
  });

  it('legacy old-API insert ES fills countryCode', async () => {
    reach(DX312_M3);
    const loc = await oldInsert(T_B, 'ES');
    expect(await pairOf(loc)).toEqual({ country: 'ES', countryCode: 'ES' });
  });

  it('legacy: an old-API legacy registration insert is rejected and leaves no tenant', async () => {
    reach(DX312_M3);
    // createClinicWithOwner de la API anterior: tenant, usuario, membresía y
    // la sede del registro legado, en una transacción como dentalix_app.
    const tenant = id(T_A, 0xa0);
    const user = id(T_A, 0xa1);
    await expect(
      target.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE dentalix_app');
        await tx.$executeRawUnsafe(
          `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
           VALUES ('${tenant}', 'Legado', 'dx312-legacy', now())`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "users" ("id", "email", "passwordHash", "fullName", "updatedAt")
           VALUES ('${user}', 'legacy@dx312.test', 'x', 'Legado', now())`,
        );
        await tx.$queryRawUnsafe(
          `SELECT set_config('app.current_tenant', $1, true)`,
          tenant,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "clinic_memberships" ("id", "tenantId", "userId", "role", "updatedAt")
           VALUES (gen_random_uuid(), '${tenant}', '${user}', 'ADMIN', now())`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "locations" (${OLD_LEGACY_REGISTRATION_COLUMNS.map((c) => `"${c}"`).join(', ')})
           VALUES (gen_random_uuid(), '${tenant}', 'Sede principal',
                   CAST('CO'::text AS "public"."ClinicCountry"), false, true,
                   now(), now())`,
        );
      }),
    ).rejects.toThrow(LEGACY_REGISTRATION_ERROR);
    // El código es check_violation (23514).
    await expect(
      asApp(
        T_A,
        `INSERT INTO "locations" (${OLD_LEGACY_REGISTRATION_COLUMNS.map((c) => `"${c}"`).join(', ')})
         VALUES (gen_random_uuid(), '${T_A}', 'Sede principal',
                 CAST('CO'::text AS "public"."ClinicCountry"), false, true,
                 now(), now())`,
      ),
    ).rejects.toThrow(/23514/);
    const [left] = await target.$queryRaw<
      { tenants: number; users: number; locations: number }[]
    >`
      SELECT (SELECT count(*)::int FROM "tenants" WHERE "id" = ${tenant}::uuid) AS tenants,
             (SELECT count(*)::int FROM "users" WHERE "id" = ${user}::uuid) AS users,
             (SELECT count(*)::int FROM "locations"
               WHERE "tenantId" = ${tenant}::uuid OR "name" = 'Sede principal') AS locations`;
    expect(left).toEqual({ tenants: 0, users: 0, locations: 0 });
  });

  it('a new-API insert of VE before the default is dropped stores no legacy country', async () => {
    reach(DX312_M3);
    // El valor por defecto de la columna antigua sigue: el trigger lo pisa.
    expect(await columnDefault('country')).not.toBeNull();
    const loc = await newInsert(T_A, 'VE', VE_REGIONAL);
    expect(await pairOf(loc)).toEqual({ country: null, countryCode: 'VE' });
  });

  it('a new-API insert of ES writes the legacy ES', async () => {
    reach(DX312_M3);
    const loc = await newInsert(T_B, 'ES', LEGACY_ES_REGIONAL);
    expect(await pairOf(loc)).toEqual({ country: 'ES', countryCode: 'ES' });
  });

  it('legacy old-API change CO → ES moves countryCode', async () => {
    reach(DX312_M3);
    const loc = await oldInsert(T_A, 'CO');
    // PATCH de la API anterior: su cliente manda "country" con el cast.
    await update(
      T_A,
      loc,
      `"country" = CAST('ES'::text AS "public"."ClinicCountry")`,
    );
    expect(await pairOf(loc)).toEqual({ country: 'ES', countryCode: 'ES' });
  });

  it('legacy old-API rewrite of the same country changes nothing', async () => {
    reach(DX312_M3);
    const loc = await oldInsert(T_A, 'CO');
    await update(
      T_A,
      loc,
      `"country" = CAST('CO'::text AS "public"."ClinicCountry")`,
    );
    expect(await pairOf(loc)).toEqual({ country: 'CO', countryCode: 'CO' });
  });

  it('a new-API change CO → VE clears the legacy country', async () => {
    reach(DX312_M3);
    const loc = await oldInsert(T_A, 'CO');
    await update(T_A, loc, `"countryCode" = 'VE'`);
    expect(await pairOf(loc)).toEqual({ country: null, countryCode: 'VE' });
  });

  it('a new-API change VE → ES writes the legacy ES', async () => {
    reach(DX312_M3);
    const loc = await newInsert(T_A, 'VE', VE_REGIONAL);
    await update(T_A, loc, `"countryCode" = 'ES'`);
    expect(await pairOf(loc)).toEqual({ country: 'ES', countryCode: 'ES' });
  });

  it('the backfill fills countryCode once and is idempotent', async () => {
    reach(DX312_M3);
    const xmins = `
      SELECT "id"::text AS id, xmin::text AS xmin FROM "locations"
      UNION ALL
      SELECT "id"::text, xmin::text FROM "pending_registrations"
      ORDER BY 1`;
    const first = await target.$queryRawUnsafe<{ id: string }[]>(xmins);
    // El cuerpo de M2 otra vez, tal cual (lección de DX-327, pre-flight M13).
    psql(db, ['-f', migrationPath(DX312_M2)]);
    expect(await target.$queryRawUnsafe(xmins)).toEqual(first);
    const [missing] = await target.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "locations"
       WHERE "countryCode" IS NULL
          OR "country" IS DISTINCT FROM public.dx_legacy_clinic_country("countryCode")`;
    expect(missing.n).toBe(0);
  });

  it('an UPDATE of both columns keeps countryCode', async () => {
    reach(DX312_M3);
    const loc = await oldInsert(T_A, 'CO');
    await update(
      T_A,
      loc,
      `"country" = CAST('ES'::text AS "public"."ClinicCountry"), "countryCode" = 'VE'`,
    );
    expect(await pairOf(loc)).toEqual({ country: null, countryCode: 'VE' });
  });

  it('countryCode outside countries is rejected by the FK', async () => {
    reach(DX312_M3);
    const loc = await oldInsert(T_A, 'CO');
    await expect(update(T_A, loc, `"countryCode" = 'ZZ'`)).rejects.toThrow(
      /locations_country_code_fkey/,
    );
    await expect(newInsert(T_A, 'ZZ', REGIONAL_TOKYO_FIXTURE)).rejects.toThrow(
      /locations_country_code_fkey/,
    );
    expect(await pairOf(loc)).toEqual({ country: 'CO', countryCode: 'CO' });
  });

  /** INSERT de un pendiente (tabla global); `columns` sustituye a la base. */
  async function insertPending(columns: Record<string, string>): Promise<Pair> {
    const n = seq++;
    const row: Record<string, string> = {
      id: 'gen_random_uuid()',
      email: `'p${n}@dx312.test'`,
      clinicName: `'Pendiente ${n}'`,
      subdomain: `'dx312-p${n}'`,
      fullName: `'P'`,
      passwordHash: `'x'`,
      tokenHash: 'md5(random()::text) || md5(random()::text)',
      expiresAt: `now() + interval '1 day'`,
      ...columns,
    };
    const [out] = await target.$queryRawUnsafe<Pair[]>(
      `INSERT INTO "pending_registrations" (${Object.keys(row)
        .map((c) => `"${c}"`)
        .join(', ')})
       VALUES (${Object.values(row).join(', ')})
       RETURNING "locationCountry"::text AS country,
                 "locationCountryCode"::text AS "countryCode"`,
    );
    return out;
  }

  it('legacy old-API pending CO fills locationCountryCode', async () => {
    reach(DX312_M3);
    expect(
      await insertPending({
        locationCountry: `'CO'`,
        locationCurrency: `'COP'`,
        locationTimeZone: `'America/Bogota'`,
        locationLocale: `'es-CO'`,
      }),
    ).toEqual({ country: 'CO', countryCode: 'CO' });
  });

  it('a new-API pending VE stores no legacy country', async () => {
    reach(DX312_M3);
    expect(
      await insertPending({
        locationCountryCode: `'VE'`,
        locationCurrency: `'VES'`,
        locationTimeZone: `'America/Caracas'`,
        locationLocale: `'es-VE'`,
      }),
    ).toEqual({ country: null, countryCode: 'VE' });
  });

  it('a pending with no location stays empty', async () => {
    reach(DX312_M3);
    // Sin paso 0 en los pendientes: los dos NULL se aceptan.
    expect(await insertPending({})).toEqual({
      country: null,
      countryCode: null,
    });
  });

  it('a new-API pending ES writes the legacy ES', async () => {
    reach(DX312_M3);
    // Una réplica anterior que confirme el enlace lo lee con su país.
    expect(
      await insertPending({
        locationCountryCode: `'ES'`,
        locationCurrency: `'EUR'`,
        locationTimeZone: `'Europe/Madrid'`,
        locationLocale: `'es-ES'`,
      }),
    ).toEqual({ country: 'ES', countryCode: 'ES' });
  });

  it('pending updates keep both columns coherent', async () => {
    reach(DX312_M3);
    // Registrarse otra vez reemplaza el pendiente (updateMany): con la API
    // nueva cambia "locationCountryCode"; con la anterior, la columna antigua.
    const email = `upd${seq}@dx312.test`;
    await insertPending({ email: `'${email}'`, locationCountry: `'CO'` });
    const set = async (assignment: string): Promise<Pair> => {
      const [row] = await target.$queryRawUnsafe<Pair[]>(
        `UPDATE "pending_registrations" SET ${assignment} WHERE "email" = $1
         RETURNING "locationCountry"::text AS country,
                   "locationCountryCode"::text AS "countryCode"`,
        email,
      );
      return row;
    };
    expect(await set(`"locationCountryCode" = 'VE'`)).toEqual({
      country: null,
      countryCode: 'VE',
    });
    expect(await set(`"locationCountry" = 'ES'`)).toEqual({
      country: 'ES',
      countryCode: 'ES',
    });
  });

  it('the TS projection and dx_legacy_clinic_country agree for every listed country', async () => {
    reach(DX312_M3);
    const codes = ISO3166_COUNTRIES.map((c) => c.code);
    const rows = await target.$queryRaw<
      { code: string; legacy: string | null }[]
    >`
      SELECT c AS code, public.dx_legacy_clinic_country(c)::text AS legacy
        FROM unnest(${codes}::text[]) AS c ORDER BY c`;
    expect(rows).toHaveLength(250);
    expect(rows).toEqual(
      codes.map((code) => ({ code, legacy: legacyClinicCountry(code) })),
    );
  });

  /** INSERT de una receta legada (singleFormat = false) sin país, más `over`. */
  const legacyRxWithoutCountry = (over: string): string =>
    `INSERT INTO "prescriptions" ("id", "tenantId", "locationId", "patientId",
         "professionalId", "country", "singleFormat", "printQuantityInWords",
         "issuedAt", "dispensationDate", "validUntil", "patientName",
         "clinicalRecordNumber", "professionalName", "professionalLicense",
         "clinicName", "locationName", "safetyRulesVersion", "safetyAlerts",
         "contentHash")
     VALUES (gen_random_uuid(), '${T_A}', '${L_CO}', '${P_A}', '${U_DR}', NULL,
             ${over}, now(), '2026-10-28', '2026-11-26', 'Paciente', 'HC-1',
             'Dra. Prueba', 'RM-1', 'Clínica A', 'Sede', '2026-10-24',
             '[]'::jsonb, '${'e'.repeat(64)}')
     RETURNING "id"::text AS id`;

  it('legacy: the old prescriptions CHECK alone lets a legacy prescription without country through', async () => {
    reach(DX312_M3);
    // Sin el CHECK nuevo, el legado vale NULL (false OR NULL OR NULL) en una
    // receta legada sin país con "clinicalRecordNumber" puesto, y un CHECK
    // que da NULL se cumple. Se deshace al terminar.
    const rollback = new Error('rollback');
    let legacyCheck: unknown;
    await expect(
      target.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `ALTER TABLE "prescriptions" DROP CONSTRAINT "prescriptions_legacy_country_present_check"`,
        );
        const [rx] = await tx.$queryRawUnsafe<{ id: string }[]>(
          legacyRxWithoutCountry('false, NULL'),
        );
        legacyCheck = await tx.$queryRawUnsafe(
          `SELECT ("singleFormat"
                   OR ("country" = 'CO' AND "clinicalRecordNumber" IS NOT NULL)
                   OR ("country" = 'ES' AND "patientDocument" IS NOT NULL
                       AND "patientBirthYear" IS NOT NULL)) IS NULL AS "isNull"
             FROM "prescriptions" WHERE "id" = $1::uuid`,
          rx.id,
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(legacyCheck).toEqual([{ isNull: true }]);
  });

  it('a legacy prescription without country is rejected by the new CHECK', async () => {
    reach(DX312_M3);
    await expect(
      target.$queryRawUnsafe(legacyRxWithoutCountry('false, NULL')),
    ).rejects.toThrow(/23514[\s\S]*prescriptions_legacy_country_present_check/);
  });

  it('a single-format prescription takes a NULL country', async () => {
    reach(DX312_M3);
    const rollback = new Error('rollback');
    let inserted: unknown;
    await expect(
      target.$transaction(async (tx) => {
        inserted = await tx.$queryRawUnsafe(
          legacyRxWithoutCountry('true, false'),
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(inserted).toHaveLength(1);
  });

  it('M3 validates the new CHECK on the existing prescriptions', async () => {
    reach(DX312_M3);
    const rows = await target.$queryRaw<{ name: string; valid: boolean }[]>`
      SELECT conname AS name, convalidated AS valid FROM pg_constraint
       WHERE conname IN ('prescriptions_legacy_country_present_check',
                         'locations_country_code_fkey',
                         'pending_registrations_location_country_code_fkey')
       ORDER BY conname`;
    expect(rows).toEqual([
      { name: 'locations_country_code_fkey', valid: true },
      { name: 'pending_registrations_location_country_code_fkey', valid: true },
      { name: 'prescriptions_legacy_country_present_check', valid: true },
    ]);
    // Las recetas sembradas conservan su país.
    const rx = await target.$queryRaw<{ id: string; country: string }[]>`
      SELECT "id"::text AS id, "country"::text AS country FROM "prescriptions"
       WHERE "id" IN (${RX_LEGACY}::uuid, ${RX_SINGLE}::uuid) ORDER BY "id"`;
    expect(rx).toEqual([
      { id: RX_LEGACY, country: 'CO' },
      { id: RX_SINGLE, country: 'ES' },
    ]);
  });

  it('an insert with regional settings and no countryCode is not taken for the legacy shape', async () => {
    reach(DX312_M3);
    // Moneda, zona y formato, sin país ni revisión: no es la forma del
    // registro legado (paso 0). Antes de M4 toma el valor por defecto de la
    // columna antigua y sale coherente; después de M4 lo rechaza el NOT NULL.
    const sql = `
      INSERT INTO "locations" ("id", "tenantId", "name", "currency", "timeZone",
                               "locale", "updatedAt")
      VALUES (gen_random_uuid(), '${T_A}', 'Regional', ${lit(REGIONAL_BOGOTA_FIXTURE.currency)},
              ${lit(REGIONAL_BOGOTA_FIXTURE.timeZone)}, ${lit(REGIONAL_BOGOTA_FIXTURE.locale)}, now())
      RETURNING "country"::text AS country, "countryCode"::text AS "countryCode"`;
    expect(await asApp<Pair>(T_A, sql)).toEqual([
      { country: 'CO', countryCode: 'CO' },
    ]);
    // Basta UNO de los cuatro (moneda, zona, formato o revisión) para que no
    // sea la forma del registro legado: el paso 0 mira exactamente esa forma.
    const single: [string, string][] = [
      ['currency', lit(REGIONAL_BOGOTA_FIXTURE.currency)],
      ['timeZone', lit(REGIONAL_BOGOTA_FIXTURE.timeZone)],
      ['locale', lit(REGIONAL_BOGOTA_FIXTURE.locale)],
      ['regionalSettingsReviewedAt', 'now()'],
    ];
    for (const [column, value] of single) {
      expect(
        await asApp<Pair>(
          T_A,
          `INSERT INTO "locations" ("id", "tenantId", "name", "${column}", "updatedAt")
           VALUES (gen_random_uuid(), '${T_A}', 'Solo ${column}', ${value}, now())
           RETURNING "country"::text AS country, "countryCode"::text AS "countryCode"`,
        ),
      ).toEqual([{ country: 'CO', countryCode: 'CO' }]);
    }
    reach(DX312_M4);
    await expect(asApp(T_A, sql)).rejects.toThrow(/23502[\s\S]*countryCode/);
  });

  it('a new-API insert of VE after M4 stores no legacy country', async () => {
    reach(DX312_M4);
    expect(await columnDefault('country')).toBeNull();
    const loc = await newInsert(T_B, 'VE', VE_REGIONAL);
    expect(await pairOf(loc)).toEqual({ country: null, countryCode: 'VE' });
  });

  it('an insert with no country is rejected after DX-312', async () => {
    reach(DX312_M4);
    await expect(
      asApp(
        T_A,
        `INSERT INTO "locations" ("id", "tenantId", "name", "currency", "timeZone",
                                  "locale", "hourCycle",
                                  "regionalSettingsReviewedAt", "updatedAt")
         VALUES (gen_random_uuid(), '${T_A}', 'Sin país', ${regional(REGIONAL_TOKYO_FIXTURE)},
                 now(), now())`,
      ),
    ).rejects.toThrow(/23502[\s\S]*countryCode/);
  });

  it('after M3 countryCode is NOT NULL with no default and no leftover CHECK', async () => {
    reach(DX312_M4);
    const columns = await target.$queryRaw<
      { column: string; nullable: string; dflt: string | null; type: string }[]
    >`
      SELECT table_name || '.' || column_name AS column, is_nullable AS nullable,
             column_default AS dflt, data_type AS type
        FROM information_schema.columns
       WHERE (table_name = 'locations' AND column_name IN ('country', 'countryCode'))
          OR (table_name = 'pending_registrations'
              AND column_name IN ('locationCountry', 'locationCountryCode'))
          OR (table_name = 'prescriptions' AND column_name = 'country')
       ORDER BY 1`;
    expect(columns).toEqual([
      {
        column: 'locations.country',
        nullable: 'YES',
        dflt: null,
        type: 'USER-DEFINED',
      },
      {
        column: 'locations.countryCode',
        nullable: 'NO',
        dflt: null,
        type: 'character',
      },
      {
        column: 'pending_registrations.locationCountry',
        nullable: 'YES',
        dflt: null,
        type: 'USER-DEFINED',
      },
      {
        column: 'pending_registrations.locationCountryCode',
        nullable: 'YES',
        dflt: null,
        type: 'character',
      },
      {
        column: 'prescriptions.country',
        nullable: 'YES',
        dflt: null,
        type: 'USER-DEFINED',
      },
    ]);
    const [leftover] = await target.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conrelid = 'public.locations'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%countryCode%'`;
    expect(leftover.n).toBe(0);
    const triggers = await target.$queryRaw<{ v: string }[]>`
      SELECT tgrelid::regclass::text || ':' || tgname AS v FROM pg_trigger
       WHERE tgname IN ('locations_country_code',
                        'pending_registrations_location_country_code')
       ORDER BY 1`;
    expect(triggers.map((t) => t.v)).toEqual([
      'locations:locations_country_code',
      'pending_registrations:pending_registrations_location_country_code',
    ]);
  });

  it('existing locations keep their country after the DX-312 migrations', async () => {
    reach(DX312_M4);
    // AC4: la foto de antes, sede a sede (también la borrada, la que no
    // tenía datos regionales y la de la ventana); "countryCode" es su país.
    expect(before.map((r) => r.id).sort()).toEqual(
      [...SEEDED_LOCATIONS].sort(),
    );
    const after = await target.$queryRawUnsafe<
      (CountryRow & { countryCode: string })[]
    >(
      `
      SELECT "id"::text AS id, "tenantId"::text AS "tenantId",
             "country"::text AS country, "countryCode"::text AS "countryCode"
        FROM "locations" WHERE "id" = ANY ($1::uuid[]) ORDER BY "id"`,
      SEEDED_LOCATIONS,
    );
    expect(
      after.map(({ id, tenantId, country }) => ({ id, tenantId, country })),
    ).toEqual(before);
    for (const row of after) expect(row.countryCode).toBe(row.country);
    expect(after.map((r) => r.country).sort()).toEqual([
      'CO',
      'CO',
      'CO',
      'CO',
      'ES',
      'ES',
    ]);
    // Los pendientes sembrados: CO y ES rellenos, el que no tiene sede vacío.
    const pendings = await target.$queryRaw<
      { email: string; country: string | null; countryCode: string | null }[]
    >`
      SELECT "email", "locationCountry"::text AS country,
             "locationCountryCode"::text AS "countryCode"
        FROM "pending_registrations"
       WHERE "email" IN ('co@dx312.test', 'es@dx312.test', 'none@dx312.test')
       ORDER BY "email"`;
    expect(pendings).toEqual([
      { email: 'co@dx312.test', country: 'CO', countryCode: 'CO' },
      { email: 'es@dx312.test', country: 'ES', countryCode: 'ES' },
      { email: 'none@dx312.test', country: null, countryCode: null },
    ]);
  });

  it('migrations shape', () => {
    const m1 = statements(DX312);
    expect(m1[0]).toBe(`SET LOCAL lock_timeout = '5s'`);
    const m1Sql = m1.join(';\n');
    expect(m1Sql).toContain(
      `ADD CONSTRAINT "locations_country_code_fkey" FOREIGN KEY ("countryCode") REFERENCES "countries"("code") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID`,
    );
    expect(m1Sql).toContain(
      `ADD CONSTRAINT "pending_registrations_location_country_code_fkey" FOREIGN KEY ("locationCountryCode") REFERENCES "countries"("code") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID`,
    );
    expect(m1Sql).toContain(
      `ADD CONSTRAINT "prescriptions_legacy_country_present_check" CHECK ("singleFormat" OR "country" IS NOT NULL) NOT VALID`,
    );
    // Ningún CHECK sobre "countryCode" en M1 (pre-flight I1) y el enum no
    // se toca.
    expect(m1.filter((s) => /CHECK\s*\([^)]*"countryCode"/.test(s))).toEqual(
      [],
    );
    expect(m1Sql).not.toMatch(/ALTER\s+TYPE\s+"?ClinicCountry/i);
    for (const name of DX312_MIGRATIONS) {
      expect(m1Sql + statements(name).join(';')).not.toMatch(
        /ALTER\s+TYPE\s+"?ClinicCountry/i,
      );
    }
    // Las funciones fijan search_path.
    const functions = m1.filter((s) => s.startsWith('CREATE FUNCTION'));
    expect(functions).toHaveLength(3);
    for (const fn of functions) {
      expect(fn).toContain('SET search_path = pg_catalog, pg_temp');
    }
    // M3 valida y pone el NOT NULL; M4 solo quita el valor por defecto.
    const m3 = statements(DX312_M3);
    expect(m3[0]).toBe(`SET LOCAL lock_timeout = '5s'`);
    expect(m3).toEqual(
      expect.arrayContaining([
        'ALTER TABLE "locations" VALIDATE CONSTRAINT "locations_country_code_fkey"',
        'ALTER TABLE "pending_registrations" VALIDATE CONSTRAINT "pending_registrations_location_country_code_fkey"',
        'ALTER TABLE "prescriptions" VALIDATE CONSTRAINT "prescriptions_legacy_country_present_check"',
        'ALTER TABLE "locations" ALTER COLUMN "countryCode" SET NOT NULL',
        'ALTER TABLE "locations" DROP CONSTRAINT "locations_country_code_not_null"',
      ]),
    );
    expect(statements(DX312_M4)).toEqual([
      `SET LOCAL lock_timeout = '5s'`,
      'ALTER TABLE "locations" ALTER COLUMN "country" DROP DEFAULT',
    ]);
    // M2 es una sola sentencia (sus COMMIT exigen ir fuera de un bloque).
    expect(statements(DX312_M2)).toHaveLength(1);
    // Ningún nombre de país salvo los valores del INSERT de M1, y ningún
    // comentario con un código del enum ni con un valor por defecto (m17).
    for (const name of DX312_MIGRATIONS) {
      const text = migrationSql(name).replace(
        /INSERT INTO "countries"[\s\S]*?ON CONFLICT[^;]*;/,
        '',
      );
      expect({
        name,
        names: text.match(/colombi|espa[ñn]a|venezuel/gi),
      }).toEqual({
        name,
        names: null,
      });
      const comments = migrationSql(name)
        .split('\n')
        .filter((line) => line.trimStart().startsWith('--'));
      expect(
        comments.filter((line) =>
          /'CO'|'ES'|DEFAULT\s+'?[A-Z]{2}\b/.test(line),
        ),
      ).toEqual([]);
    }
  });

  it('locations and prescriptions keep FORCE row level security', async () => {
    reach(DX312_M4);
    const rows = await target.$queryRaw<{ table: string; forced: boolean }[]>`
      SELECT relname AS table, relforcerowsecurity AS forced FROM pg_class
       WHERE oid IN ('public.locations'::regclass,
                     'public.prescriptions'::regclass)
       ORDER BY relname`;
    expect(rows).toEqual([
      { table: 'locations', forced: true },
      { table: 'prescriptions', forced: true },
    ]);
  });
});
