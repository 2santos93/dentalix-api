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
import { DOCUMENT_TYPES } from '../src/modules/patients/domain/document-type';
import {
  DOC_TYPE_NAME_FIELD,
  DOC_TYPE_NAME_MAX,
} from '../src/modules/patients/domain/document-type-names';

// DX-327 (R16, spec §3.6): nombre local de cada tipo de documento, por
// clínica. Una BD desechable recibe todas las migraciones ANTERIORES a M4 y
// clínicas como las de hoy; se aplica M4 y se comprueba que cada clínica
// queda con los cinco nombres a NULL (sin relleno ni valor por defecto), el
// CHECK de cada columna y la forma de la migración.

const M4 = '20261030120300_dx327_tenant_document_type_names';
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

/** Las sentencias de M4, sin comentarios y con los espacios juntados. */
function statements(): string[] {
  return readFileSync(
    join(ROOT, 'prisma/migrations', M4, 'migration.sql'),
    'utf8',
  )
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const T_A = '00000000-0000-4000-8000-000000327c01';
const T_B = '00000000-0000-4000-8000-000000327c02';
const T_GONE = '00000000-0000-4000-8000-000000327c03';

const SEED = [
  `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt", "deletedAt")
   VALUES ('${T_A}', 'Clínica A', 'dx327-names-a', now(), NULL),
          ('${T_B}', 'Clínica B', 'dx327-names-b', now(), NULL),
          ('${T_GONE}', 'Clínica cerrada', 'dx327-names-gone', now(), now())`,
];

const COLUMNS = DOCUMENT_TYPES.map((type) => DOC_TYPE_NAME_FIELD[type]);

describe('DX-327 · M4, nombre local de cada tipo por clínica (int)', () => {
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let db: string;
  let dir: string;
  let target: PrismaClient;
  // Versión (xmin) y updatedAt de cada clínica antes y justo después de M4.
  let rowVersionsBefore: string;
  let rowVersionsAfter: string;

  const rowVersions = async (): Promise<string> => {
    const rows = await target.$queryRaw<{ v: string }[]>`
      SELECT string_agg("id"::text || ':' || xmin::text || ':'
                        || "updatedAt"::text, ',' ORDER BY "id") AS v
        FROM "tenants"`;
    return rows[0].v;
  };

  beforeAll(async () => {
    db = `dx327_names_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'dx327-names-'));
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
    for (const name of all.filter((n) => n < M4)) copy(name);
    migrateDeploy(dir, urlFor(db));
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    for (const sql of SEED) await target.$executeRawUnsafe(sql);
    rowVersionsBefore = await rowVersions();
    for (const name of all.filter((n) => n >= M4)) copy(name);
    migrateDeploy(dir, urlFor(db));
    rowVersionsAfter = await rowVersions();
  }, 240_000);

  afterAll(async () => {
    await target?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    rmSync(dir, { recursive: true, force: true });
    await admin.$disconnect();
  }, 60_000);

  it('every existing clinic gets five null local names', async () => {
    const rows = await target.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT "id", ${COLUMNS.map((c) => `"${c}"`).join(', ')}
         FROM "tenants" ORDER BY "id"`,
    );
    expect(rows.map((r) => r.id)).toEqual([T_A, T_B, T_GONE]);
    for (const row of rows) {
      for (const column of COLUMNS) expect(row[column]).toBeNull();
    }
    const columns = await target.$queryRaw<
      { name: string; nullable: string; columnDefault: string | null }[]
    >`
      SELECT column_name AS name, is_nullable AS nullable,
             column_default AS "columnDefault"
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tenants'
         AND column_name LIKE 'docTypeName%'
       ORDER BY ordinal_position`;
    expect(columns).toEqual(
      COLUMNS.map((name) => ({ name, nullable: 'YES', columnDefault: null })),
    );
    // Una clínica creada después sin nombrar las columnas (la API, o una
    // réplica anterior) tampoco recibe ninguno.
    const [created] = await target.$queryRawUnsafe<Record<string, unknown>[]>(
      `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
       VALUES (gen_random_uuid(), 'Clínica nueva', 'dx327-names-new', now())
       RETURNING ${COLUMNS.map((c) => `"${c}"`).join(', ')}`,
    );
    for (const column of COLUMNS) expect(created[column]).toBeNull();
  });

  it('the local name CHECK takes 1–60 trimmed characters', async () => {
    const set = (column: string, value: string | null) =>
      target.$executeRawUnsafe(
        `UPDATE "tenants" SET "${column}" = $1 WHERE "id" = '${T_A}'`,
        value,
      );
    const checks = await target.$queryRaw<{ name: string; valid: boolean }[]>`
      SELECT conname AS name, convalidated AS valid FROM pg_constraint
       WHERE conrelid = 'public.tenants'::regclass
         AND conname LIKE 'tenants_doc_type_name_%'
       ORDER BY conname`;
    expect(checks).toHaveLength(5);
    expect(checks.every((c) => c.valid)).toBe(true);
    try {
      for (const column of COLUMNS) {
        for (const bad of ['', ' ID local', 'ID local ', 'a'.repeat(61)]) {
          await expect(set(column, bad)).rejects.toThrow(
            /tenants_doc_type_name_\w+_check/,
          );
        }
        // 60 puntos de código (120 unidades UTF-16) y nombres en cualquier
        // escritura.
        const sixty = '😀'.repeat(DOC_TYPE_NAME_MAX);
        for (const ok of ['V', 'ID local', 'Документ А', '文書A', sixty]) {
          await expect(set(column, ok)).resolves.toBe(1);
        }
        await expect(set(column, null)).resolves.toBe(1);
      }
    } finally {
      for (const column of COLUMNS) await set(column, null);
    }
  });

  it('M4 sets lock_timeout and writes no row', () => {
    const sql = statements();
    expect(sql[0]).toBe(`SET LOCAL lock_timeout = '5s'`);
    for (const statement of sql.slice(1)) {
      expect(statement).toMatch(/^ALTER TABLE "tenants" /);
    }
    expect(sql.join('\n')).not.toMatch(
      /\b(UPDATE|INSERT|DELETE|DEFAULT|TRUNCATE)\b/i,
    );
    // Ninguna fila de las clínicas existentes cambió de versión.
    expect(rowVersionsAfter).toBe(rowVersionsBefore);
  });
});
