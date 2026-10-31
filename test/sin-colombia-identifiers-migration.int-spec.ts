// Excepción G5.3 (DX-334): códigos anteriores a DX-326 y DX-327, para
// comprobar que la migración que los retira no pierde nada.
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

// Sin Colombia (DX-323): una BD desechable recibe todas las migraciones
// ANTERIORES a 20261110130000 y filas como las dejaba la API anterior (tipos
// de pagador con código antiguo, pacientes y contactos con CC/TI/CE escritos
// por un escritor anterior, el texto de aseguradora y su cobertura migrada);
// se aplica la migración y se comprueba que cada fila sigue ahí con el mismo
// dato, traducido o renombrado, y que no queda ningún objeto con el nombre
// antiguo. Solo SQL: no depende del cliente de Prisma.

const MIGRATION = '20261110130000_sin_colombia_identificadores';
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

const T_X = '00000000-0000-4000-8000-00000c2a0000';
const T_Y = '00000000-0000-4000-8000-00000c2b0000';
const uid = (tenant: string, n: number): string =>
  `${tenant.slice(0, -2)}${n.toString(16).padStart(2, '0')}`;

const OLD_PAYER_TYPES = [
  'MUTUA_ES',
  'PREPAGADA_CO',
  'EPS_CO',
  'EMPRESA',
  'OTRO',
];
const GENERIC_PAYER_TYPES = [
  'INSURER',
  'PREPAID_PLAN',
  'PUBLIC_SYSTEM',
  'EMPLOYER',
  'OTHER',
];

const payers = (tenant: string): string =>
  [...OLD_PAYER_TYPES, 'INSURER', 'OTHER']
    .map(
      (type, i) =>
        `('${uid(tenant, 0x10 + i)}', '${tenant}', 'Pagador ${i}', '${type}', now())`,
    )
    .join(',\n');

// Escritor anterior: solo "docType" (el trigger de DX-327 deriva el genérico).
const patients = (tenant: string): string =>
  [
    ['CC', 'Aseguradora Uno', null],
    ['TI', null, null],
    ['CE', '  aseguradora uno ', null],
    ['PASSPORT', null, null],
    ['OTHER', null, null],
    ['CC', 'Borrada', 'now()'],
  ]
    .map(
      ([code, insurer, deleted], i) =>
        `('${uid(tenant, 0x30 + i)}', '${tenant}', 'Doc', '${code}', '${code}',
          'C2-${i}', ${insurer === null ? 'NULL' : `'${insurer}'`},
          ${deleted ?? 'NULL'}, now())`,
    )
    .join(',\n');

const SEED = [
  `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
   VALUES ('${T_X}', 'Clínica X', 'c2-x', now()),
          ('${T_Y}', 'Clínica Y', 'c2-y', now())`,
  `INSERT INTO "payers" ("id", "tenantId", "name", "type", "updatedAt")
   VALUES ${payers(T_X)}, ${payers(T_Y)}`,
  `INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName", "docType",
                           "docNumber", "insurerEps", "deletedAt", "updatedAt")
   VALUES ${patients(T_X)}, ${patients(T_Y)}`,
  // Escritor de fase 1: la pareja y una etiqueta.
  `INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName", "docType",
                           "documentType", "docTypeLabel", "docNumber", "updatedAt")
   VALUES ('${uid(T_X, 0x40)}', '${T_X}', 'Doc', 'Fiscal', 'OTHER', 'TAX_ID',
           'ID local', 'C2-40', now())`,
  `INSERT INTO "patient_responsible_parties"
     ("id", "tenantId", "patientId", "responsiblePatientId", "fullName",
      "docType", "docNumber", "relationship", "updatedAt")
   VALUES ('${uid(T_X, 0x50)}', '${T_X}', '${uid(T_X, 0x31)}', NULL, 'Madre',
           'CE', 'C2-50', 'MOTHER', now()),
          ('${uid(T_X, 0x51)}', '${T_X}', '${uid(T_X, 0x32)}', NULL, 'Sin doc',
           NULL, NULL, 'OTHER', now()),
          ('${uid(T_X, 0x52)}', '${T_X}', '${uid(T_X, 0x33)}', '${uid(T_X, 0x30)}',
           NULL, NULL, NULL, 'SIBLING', now())`,
  `INSERT INTO "patient_coverages"
     ("id", "tenantId", "patientId", "payerId", "isPrimary",
      "migratedFromInsurerEps", "updatedAt")
   VALUES ('${uid(T_X, 0x60)}', '${T_X}', '${uid(T_X, 0x30)}', '${uid(T_X, 0x12)}',
           true, true, now()),
          ('${uid(T_X, 0x61)}', '${T_X}', '${uid(T_X, 0x31)}', '${uid(T_X, 0x10)}',
           true, false, now())`,
  `INSERT INTO "agreements" ("id", "tenantId", "name", "payerId", "kind",
                             "percent", "updatedAt")
   VALUES ('${uid(T_X, 0x70)}', '${T_X}', 'Convenio', '${uid(T_X, 0x12)}',
           'PERCENT_DISCOUNT', 10, now())`,
];

interface Row {
  k: string;
}

/** Una línea por fila, con su dato antiguo o nuevo según `phase`. */
const SNAPSHOT = (phase: 'before' | 'after'): string => {
  const doc = phase === 'before' ? '"docType"' : '"legacyDocumentCode"';
  const insurer = phase === 'before' ? '"insurerEps"' : '"legacyInsurerName"';
  const migrated =
    phase === 'before'
      ? '"migratedFromInsurerEps"'
      : '"migratedFromLegacyInsurer"';
  return `
    SELECT k FROM (
      SELECT 'payer:' || "id" || ':' || "tenantId" || ':' || "name" || ':'
             || "type"::text || ':' || "active"::text AS k FROM "payers"
      UNION ALL
      SELECT 'patient:' || "id" || ':' || coalesce(${doc}::text, '-') || ':'
             || "documentType"::text || ':' || coalesce("docTypeLabel", '-') || ':'
             || coalesce("docNumber", '-') || ':' || coalesce("docKey", '-') || ':'
             || coalesce(${insurer}, '-') || ':' || ("deletedAt" IS NULL)::text
        FROM "patients"
      UNION ALL
      SELECT 'party:' || "id" || ':' || coalesce(${doc}::text, '-') || ':'
             || coalesce("documentType"::text, '-') || ':'
             || coalesce("docNumber", '-') || ':'
             || coalesce("responsiblePatientId"::text, '-')
        FROM "patient_responsible_parties"
      UNION ALL
      SELECT 'coverage:' || "id" || ':' || "payerId" || ':' || ${migrated}::text
        FROM "patient_coverages"
      UNION ALL
      SELECT 'agreement:' || "id" || ':' || "payerId" FROM "agreements"
    ) s ORDER BY k COLLATE "C"`;
};

const PAYER_RENAME: Record<string, string> = Object.fromEntries(
  OLD_PAYER_TYPES.map((code, i) => [code, GENERIC_PAYER_TYPES[i]]),
);
const DOC_RENAME: Record<string, string> = {
  CC: 'NATIONAL_ID',
  TI: 'MINOR_ID',
  CE: 'FOREIGNER_ID',
};

/** Lo que tiene que quedar: cada valor antiguo con su nombre nuevo. */
function expected(line: string): string {
  const [kind, ...rest] = line.split(':');
  if (kind === 'payer') {
    rest[3] = PAYER_RENAME[rest[3]] ?? rest[3];
  } else if (kind === 'patient' || kind === 'party') {
    rest[1] = DOC_RENAME[rest[1]] ?? rest[1];
  }
  return [kind, ...rest].join(':');
}

describe('Sin Colombia · migración de los identificadores (int)', () => {
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let db: string;
  let dir: string;
  let target: PrismaClient;
  let before: string[];

  const scalar = async <T>(sql: string): Promise<T> =>
    (await target.$queryRawUnsafe<{ v: T }[]>(sql))[0].v;

  beforeAll(async () => {
    db = `c2_sincol_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'c2-sincol-'));
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
    for (const name of all.filter((n) => n < MIGRATION)) copy(name);
    migrateDeploy(dir, urlFor(db));
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    for (const sql of SEED) await target.$executeRawUnsafe(sql);
    before = (await target.$queryRawUnsafe<Row[]>(SNAPSHOT('before'))).map(
      (r) => r.k,
    );
    for (const name of all.filter((n) => n >= MIGRATION)) copy(name);
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

  it('the seed is what the previous API left: old payer codes, CC/TI/CE and the insurer text', () => {
    expect(before.filter((k) => k.startsWith('payer:'))).toHaveLength(14);
    expect(before.join('\n')).toMatch(/:EPS_CO:/);
    expect(before.join('\n')).toMatch(/patient:[^:]+:TI:NATIONAL_ID:/);
    expect(before.join('\n')).toMatch(/party:[^:]+:CE:RESIDENCE_PERMIT:/);
    expect(before.join('\n')).toMatch(/:Aseguradora Uno:/);
    expect(before.join('\n')).toMatch(/coverage:[^:]+:[^:]+:true/);
  });

  it('every row survives with its value translated or renamed, nothing else changes', async () => {
    const after = (await target.$queryRawUnsafe<Row[]>(SNAPSHOT('after'))).map(
      (r) => r.k,
    );
    expect(after).toHaveLength(before.length);
    expect([...after].sort()).toEqual(before.map(expected).sort());
  });

  it('PayerType has only the five generic values, in order', async () => {
    expect(
      await scalar<string>(
        `SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS v
           FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'PayerType'`,
      ),
    ).toBe(GENERIC_PAYER_TYPES.join(','));
    await expect(
      target.$executeRawUnsafe(
        `INSERT INTO "payers" ("id", "tenantId", "name", "type", "updatedAt")
         VALUES (gen_random_uuid(), '${T_Y}', 'Nuevo', 'EPS_CO', now())`,
      ),
    ).rejects.toThrow(/invalid input value for enum/);
  });

  it('the old document enum is renamed with generic values; no old name remains in the catalogue', async () => {
    expect(
      await scalar<string>(
        `SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS v
           FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'LegacyDocumentCode'`,
      ),
    ).toBe('NATIONAL_ID,MINOR_ID,FOREIGNER_ID,PASSPORT,OTHER');
    expect(
      await scalar<number>(
        `SELECT ((SELECT count(*) FROM pg_type
                  WHERE typname IN ('DocType', 'PayerType_generic'))
              + (SELECT count(*) FROM pg_enum
                  WHERE enumlabel IN ('CC', 'TI', 'CE', 'MUTUA_ES',
                                      'PREPAGADA_CO', 'EPS_CO', 'EMPRESA', 'OTRO'))
              + (SELECT count(*) FROM information_schema.columns
                  WHERE table_schema = 'public'
                    AND (column_name LIKE '%Eps%' OR column_name = 'docType'))
              + (SELECT count(*) FROM pg_proc
                  WHERE proname LIKE 'dx\\_doc\\_type\\_%'
                     OR proname = 'dx_document_type_sync')
              + (SELECT count(*) FROM pg_trigger
                  WHERE tgname LIKE '%\\_document\\_type'))::int
              AS v`,
      ),
    ).toBe(0);
  });

  it('the frozen column has no default and new rows leave it NULL', async () => {
    const id = uid(T_Y, 0x90);
    await target.$executeRawUnsafe(
      `INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName",
                               "documentType", "updatedAt")
       VALUES ('${id}', '${T_Y}', 'Nuevo', 'Paciente', 'PASSPORT', now())`,
    );
    expect(
      await scalar<string>(
        `SELECT coalesce("legacyDocumentCode"::text, '-') || '/' || "documentType"::text AS v
           FROM "patients" WHERE "id" = '${id}'`,
      ),
    ).toBe('-/PASSPORT');
    // Sin trigger: cambiar el genérico no toca la columna congelada.
    await target.$executeRawUnsafe(
      `UPDATE "patients" SET "documentType" = 'TAX_ID'
        WHERE "id" = '${uid(T_X, 0x31)}'`,
    );
    expect(
      await scalar<string>(
        `SELECT "legacyDocumentCode"::text || '/' || "documentType"::text AS v
           FROM "patients" WHERE "id" = '${uid(T_X, 0x31)}'`,
      ),
    ).toBe('MINOR_ID/TAX_ID');
  });

  it('the partial index of migrated coverages follows the renamed column', async () => {
    expect(
      await scalar<string>(
        `SELECT indexdef AS v FROM pg_indexes
          WHERE indexname = 'patient_coverages_migrated_key'`,
      ),
    ).toContain('WHERE "migratedFromLegacyInsurer"');
  });

  it('payers, patients, contacts and coverages keep FORCE row level security', async () => {
    expect(
      await scalar<string>(
        `SELECT string_agg(relname || '=' || relforcerowsecurity, ','
                ORDER BY relname) AS v
           FROM pg_class
          WHERE oid IN ('public.payers'::regclass, 'public.patients'::regclass,
                        'public.patient_responsible_parties'::regclass,
                        'public.patient_coverages'::regclass)`,
      ),
    ).toBe(
      'patient_coverages=true,patient_responsible_parties=true,patients=true,payers=true',
    );
  });

  it('the migration only renames or translates: no DROP COLUMN, no DROP TABLE, no DELETE', () => {
    const sql = readFileSync(
      join(ROOT, 'prisma/migrations', MIGRATION, 'migration.sql'),
      'utf8',
    )
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    expect(sql).not.toMatch(
      /DROP\s+COLUMN|DROP\s+TABLE|DELETE\s+FROM|TRUNCATE/i,
    );
    expect(sql).toMatch(/RENAME VALUE 'TI' TO 'MINOR_ID'/);
  });
});
