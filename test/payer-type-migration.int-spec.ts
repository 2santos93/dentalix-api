// Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326.
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
import { REGIONAL_TOKYO_FIXTURE } from './support/location-fixtures';

// DX-326 (fase 1): el enum PayerType gana los cinco tipos genéricos y se va
// el CHECK de tipo y país de `payers`, sin relleno. Una BD desechable recibe
// todas las migraciones ANTERIORES y dos clínicas con un pagador por código
// guardado (con el país que hasta ahora exigía el CHECK), coberturas y un
// convenio; se aplican las dos migraciones y se comprueba que ningún pagador
// cambia, que el enum tiene los diez valores en orden, que cualquier tipo
// entra con cualquier país o ninguno y que FORCE sigue en `payers`. Solo SQL:
// no depende del cliente de Prisma.

const DX326 = '20261029120000_dx326_payer_type_generic_values';
const ENUM_MIGRATION = DX326;
const CHECK_MIGRATION = '20261029120100_dx326_payers_drop_type_country_check';
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

const T_X = '00000000-0000-4000-8000-0000000326a1';
const T_Y = '00000000-0000-4000-8000-0000000326b1';
const P_X1 = '00000000-0000-4000-8000-0000000326a2';
const P_X2 = '00000000-0000-4000-8000-0000000326a3';
const EPS_X = '00000000-0000-4000-8000-0000000326a4';

// El país de la sede lo obliga el enum hasta DX-312; no decide nada.
const location = (tenant: string): string =>
  `(gen_random_uuid(), '${tenant}', 'Sede 1', '${REGIONAL_TOKYO_FIXTURE.country}',
    '${REGIONAL_TOKYO_FIXTURE.currency}', '${REGIONAL_TOKYO_FIXTURE.timeZone}',
    '${REGIONAL_TOKYO_FIXTURE.locale}', '${REGIONAL_TOKYO_FIXTURE.hourCycle}', now())`;

/** Un pagador por código guardado, con el país que exige el CHECK de hoy. */
const payers = (tenant: string, epsId: string): string =>
  [
    `(gen_random_uuid(), '${tenant}', 'Aseguradora Norte', 'MUTUA_ES', 'ES', true, now())`,
    `(gen_random_uuid(), '${tenant}', 'Plan Sur', 'PREPAGADA_CO', 'CO', true, now())`,
    `('${epsId}', '${tenant}', 'Sistema Público Central', 'EPS_CO', 'CO', true, now())`,
    `(gen_random_uuid(), '${tenant}', 'Empresa Alfa', 'EMPRESA', NULL, true, now())`,
    `(gen_random_uuid(), '${tenant}', 'Cortesía empleados', 'OTRO', NULL, false, now())`,
  ].join(',\n');

// Clínicas como las deja DX-324, antes de DX-326.
const SEED = [
  `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
   VALUES ('${T_X}', 'Clínica X', 'dx326-x', now()),
          ('${T_Y}', 'Clínica Y', 'dx326-y', now())`,
  `INSERT INTO "locations" ("id", "tenantId", "name", "country", "currency",
                            "timeZone", "locale", "hourCycle", "updatedAt")
   VALUES ${location(T_X)}, ${location(T_Y)}`,
  `INSERT INTO "payers" ("id", "tenantId", "name", "type", "country", "active",
                         "updatedAt")
   VALUES ${payers(T_X, EPS_X)},
          ${payers(T_Y, '00000000-0000-4000-8000-0000000326b4')}`,
  `INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName", "updatedAt")
   VALUES ('${P_X1}', '${T_X}', 'Uno', 'Equis', now()),
          ('${P_X2}', '${T_X}', 'Dos', 'Equis', now())`,
  `INSERT INTO "patient_coverages" ("id", "tenantId", "patientId", "payerId",
                                    "isPrimary", "updatedAt")
   VALUES (gen_random_uuid(), '${T_X}', '${P_X1}', '${EPS_X}', true, now()),
          (gen_random_uuid(), '${T_X}', '${P_X2}', '${EPS_X}', true, now())`,
  `INSERT INTO "agreements" ("id", "tenantId", "name", "payerId", "kind",
                             "percent", "updatedAt")
   VALUES (gen_random_uuid(), '${T_X}', 'Convenio central', '${EPS_X}',
           'PERCENT_DISCOUNT', 10, now())`,
];

interface PayerRow {
  id: string;
  tenantId: string;
  name: string;
  type: string;
  country: string | null;
  active: boolean;
  coverages: number;
  agreements: number;
}

const SNAPSHOT = `
  SELECT p."id"::text AS id, p."tenantId"::text AS "tenantId", p."name",
         p."type"::text AS type, p."country"::text AS country, p."active",
         (SELECT count(*)::int FROM "patient_coverages" c
           WHERE c."payerId" = p."id") AS coverages,
         (SELECT count(*)::int FROM "agreements" a
           WHERE a."payerId" = p."id") AS agreements
    FROM "payers" p
   ORDER BY p."tenantId", p."name" COLLATE "C"`;

/** Las sentencias de una migración, sin comentarios. */
function statements(name: string): string[] {
  return readFileSync(
    join(ROOT, 'prisma/migrations', name, 'migration.sql'),
    'utf8',
  )
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

describe('DX-326 · migraciones de los tipos de pagador genéricos (int)', () => {
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let db: string;
  let dir: string;
  let target: PrismaClient;
  let before: PayerRow[];

  beforeAll(async () => {
    db = `dx326_mig_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'dx326-'));
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
    for (const name of all.filter((n) => n < DX326)) copy(name);
    migrateDeploy(dir, urlFor(db));
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    for (const sql of SEED) await target.$executeRawUnsafe(sql);
    before = await target.$queryRawUnsafe<PayerRow[]>(SNAPSHOT);
    for (const name of all.filter((n) => n >= DX326)) copy(name);
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

  /** Inserta un pagador por SQL en T_Y y lo borra; resuelve con su recuento. */
  async function insertPayer(
    name: string,
    type: string,
    country: string | null,
  ): Promise<number> {
    try {
      return await target.$executeRawUnsafe(
        `INSERT INTO "payers" ("id", "tenantId", "name", "type", "country", "updatedAt")
         VALUES (gen_random_uuid(), '${T_Y}', $1, $2::"PayerType",
                 $3::"ClinicCountry", now())`,
        name,
        type,
        country,
      );
    } finally {
      await target.$executeRawUnsafe(
        `DELETE FROM "payers" WHERE "tenantId" = '${T_Y}' AND "name" = $1`,
        name,
      );
    }
  }

  it('existing payers keep id, type, country and coverages after the DX-326 migrations', async () => {
    expect(before).toHaveLength(10);
    expect(
      before.map((r) => `${r.type}/${r.country ?? '-'}`).slice(0, 5),
    ).toEqual([
      'MUTUA_ES/ES',
      'OTRO/-',
      'EMPRESA/-',
      'PREPAGADA_CO/CO',
      'EPS_CO/CO',
    ]);
    expect(before.find((r) => r.id === EPS_X)).toMatchObject({
      coverages: 2,
      agreements: 1,
    });
    expect(await target.$queryRawUnsafe<PayerRow[]>(SNAPSHOT)).toEqual(before);
  });

  it('PayerType has the five legacy values and the five generic ones, in that order', async () => {
    const rows = await target.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'PayerType'
       ORDER BY e.enumsortorder`;
    expect(rows.map((r) => r.label)).toEqual([
      'MUTUA_ES',
      'PREPAGADA_CO',
      'EPS_CO',
      'EMPRESA',
      'OTRO',
      'INSURER',
      'PREPAID_PLAN',
      'PUBLIC_SYSTEM',
      'EMPLOYER',
      'OTHER',
    ]);
  });

  it('the type × country CHECK is gone: any stored type with any or no country inserts', async () => {
    const [check] = await target.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conrelid = 'public.payers'::regclass
         AND conname = 'payers_type_country_check'`;
    expect(check.n).toBe(0);
    await expect(insertPayer('Pagador 1', 'MUTUA_ES', 'CO')).resolves.toBe(1);
    await expect(insertPayer('Pagador 2', 'PREPAGADA_CO', null)).resolves.toBe(
      1,
    );
    await expect(insertPayer('Pagador 3', 'INSURER', 'ES')).resolves.toBe(1);
    await expect(insertPayer('Pagador 4', 'OTHER', null)).resolves.toBe(1);
  });

  it('an old-API insert (legacy code with country) still succeeds', async () => {
    // Lo que envía el cliente Prisma de una réplica anterior a DX-326.
    await expect(insertPayer('Réplica antigua', 'EPS_CO', 'CO')).resolves.toBe(
      1,
    );
  });

  it('ADD VALUE and DROP CONSTRAINT live in separate migrations', () => {
    // Un valor añadido no se usa en la misma transacción que lo crea.
    const enumSql = statements(ENUM_MIGRATION);
    expect(enumSql[0]).toBe(`SET LOCAL lock_timeout = '5s'`);
    expect(enumSql.slice(1)).toEqual(
      ['INSURER', 'PREPAID_PLAN', 'PUBLIC_SYSTEM', 'EMPLOYER', 'OTHER'].map(
        (v) => `ALTER TYPE "PayerType" ADD VALUE IF NOT EXISTS '${v}'`,
      ),
    );
    const checkSql = statements(CHECK_MIGRATION);
    expect(checkSql[0]).toBe(`SET LOCAL lock_timeout = '5s'`);
    expect(checkSql.join(';')).not.toMatch(/ALTER\s+TYPE/i);
    expect(checkSql.slice(1)).toEqual([
      'ALTER TABLE "payers" DROP CONSTRAINT "payers_type_country_check"',
    ]);
  });

  it('payers keeps FORCE row level security', async () => {
    const [row] = await target.$queryRaw<{ forced: boolean }[]>`
      SELECT relforcerowsecurity AS forced FROM pg_class
       WHERE oid = 'public.payers'::regclass`;
    expect(row.forced).toBe(true);
  });
});
