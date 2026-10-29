// Excepción G5.3 (DX-334): tipos de documento anteriores a DX-327.
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

// DX-327 (fase 1): el tipo de documento genérico va en una columna nueva
// ("documentType", con "docTypeLabel" al lado) y la antigua ("docType") se
// queda, mantenida por el trigger *_document_type para las réplicas
// anteriores. Una BD desechable recibe todas las migraciones ANTERIORES y dos
// clínicas con un paciente por código guardado, uno borrado, uno sin
// documento, un contacto y un responsable que es paciente; se aplican las
// tres migraciones y se comprueba que nada cambia salvo el tipo genérico, que
// nadie recibe etiqueta, que docKey deduplica igual, cada caso del trigger
// (spec §3.3) y la forma de las migraciones. Solo SQL: no depende del
// cliente de Prisma.

const DX327 = '20261030120000_dx327_document_type';
const BACKFILL = '20261030120100_dx327_document_type_backfill';
const VALIDATE = '20261030120200_dx327_document_type_validate';
const DX327_MIGRATIONS = [DX327, BACKFILL, VALIDATE];
const ROOT = join(__dirname, '..');
const LIVE_IDX = 'patients_tenant_doc_key_live_idx';

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
      {
        stdio: 'pipe',
      },
    );
  } catch (err) {
    const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `psql falló:\n${String(stdout ?? '')}${String(stderr ?? '')}`,
    );
  }
}

function migrationSql(name: string): string {
  return readFileSync(
    join(ROOT, 'prisma/migrations', name, 'migration.sql'),
    'utf8',
  );
}

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

/** R3: código antiguo → tipo genérico. Ninguno da etiqueta. */
const R3: Record<string, string> = {
  CC: 'NATIONAL_ID',
  TI: 'NATIONAL_ID',
  CE: 'RESIDENCE_PERMIT',
  PASSPORT: 'PASSPORT',
  OTHER: 'OTHER',
};

const T_X = '00000000-0000-4000-8000-000000327a00';
const T_Y = '00000000-0000-4000-8000-000000327b00';
const id = (tenant: string, n: number): string =>
  `${tenant.slice(0, -2)}${n.toString(16).padStart(2, '0')}`;
// Pacientes sembrados en cada clínica (con su código guardado).
const CC = 1;
const TI = 2;
const CE = 3;
const PASSPORT = 4;
const OTHER = 5;
const DELETED = 9;
const NO_DOC = 10;
const CONTACT = 0x50;
const RESPONSIBLE_PATIENT = 0x51;

// El país de la sede lo obliga el enum hasta DX-312; no decide nada.
const location = (tenant: string): string =>
  `(gen_random_uuid(), '${tenant}', 'Sede 1', '${REGIONAL_TOKYO_FIXTURE.country}',
    '${REGIONAL_TOKYO_FIXTURE.currency}', '${REGIONAL_TOKYO_FIXTURE.timeZone}',
    '${REGIONAL_TOKYO_FIXTURE.locale}', '${REGIONAL_TOKYO_FIXTURE.hourCycle}', now())`;

const patients = (t: string): string =>
  [
    `('${id(t, CC)}', '${t}', 'Uno', 'Doc', 'CC', '1.111.111', NULL, now())`,
    `('${id(t, TI)}', '${t}', 'Dos', 'Doc', 'TI', '1111111', NULL, now())`,
    `('${id(t, CE)}', '${t}', 'Tres', 'Doc', 'CE', 'RX-0003', NULL, now())`,
    `('${id(t, PASSPORT)}', '${t}', 'Cuatro', 'Doc', 'PASSPORT', 'RX-0004', NULL, now())`,
    `('${id(t, OTHER)}', '${t}', 'Cinco', 'Doc', 'OTHER', 'RX-0005', NULL, now())`,
    `('${id(t, DELETED)}', '${t}', 'Borrado', 'Doc', 'CC', 'RX-0009', now(), now())`,
    `('${id(t, NO_DOC)}', '${t}', 'Sin', 'Doc', DEFAULT, NULL, NULL, now())`,
  ].join(',\n');

const responsibles = (t: string): string =>
  [
    `('${id(t, CONTACT)}', '${t}', '${id(t, CC)}', NULL, 'Contacto Uno', 'TI', 'RX-0050', 'MOTHER', now())`,
    `('${id(t, RESPONSIBLE_PATIENT)}', '${t}', '${id(t, CC)}', '${id(t, TI)}', NULL, NULL, NULL, 'SIBLING', now())`,
  ].join(',\n');

// Clínicas como las deja DX-326, antes de DX-327.
const SEED = [
  `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
   VALUES ('${T_X}', 'Clínica X', 'dx327-x', now()),
          ('${T_Y}', 'Clínica Y', 'dx327-y', now())`,
  `INSERT INTO "locations" ("id", "tenantId", "name", "country", "currency",
                            "timeZone", "locale", "hourCycle", "updatedAt")
   VALUES ${location(T_X)}, ${location(T_Y)}`,
  `INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName", "docType",
                           "docNumber", "deletedAt", "updatedAt")
   VALUES ${patients(T_X)},
          ${patients(T_Y)}`,
  `INSERT INTO "patient_responsible_parties" ("id", "tenantId", "patientId",
       "responsiblePatientId", "fullName", "docType", "docNumber",
       "relationship", "updatedAt")
   VALUES ${responsibles(T_X)},
          ${responsibles(T_Y)}`,
];

interface SnapshotRow {
  tabla: string;
  id: string;
  tenantId: string;
  docNumber: string | null;
  docKey: string | null;
  docType: string | null;
}

const SNAPSHOT = `
  SELECT 'patients' AS tabla, "id"::text AS id, "tenantId"::text AS "tenantId",
         "docNumber", "docKey", "docType"::text AS "docType"
    FROM "patients"
  UNION ALL
  SELECT 'responsables', "id"::text, "tenantId"::text, "docNumber", NULL,
         "docType"::text
    FROM "patient_responsible_parties"
   ORDER BY 1, 2`;

interface TypeRow {
  tabla: string;
  id: string;
  docType: string | null;
  documentType: string | null;
  docTypeLabel: string | null;
}

const TYPES = `
  SELECT 'patients' AS tabla, "id"::text AS id, "docType"::text AS "docType",
         "documentType"::text AS "documentType", "docTypeLabel"
    FROM "patients"
  UNION ALL
  SELECT 'responsables', "id"::text, "docType"::text, "documentType"::text,
         "docTypeLabel"
    FROM "patient_responsible_parties"
   ORDER BY 1, 2`;

/** livePatientWithDoc en SQL (predicado del índice parcial). */
const LIVE_WITH_DOC = `
  SELECT "id"::text AS id FROM "patients"
   WHERE "tenantId" = $1::uuid AND "deletedAt" IS NULL
     AND "docNumber" IS NOT NULL AND "docKey" = public.dx_doc_key($2)
   ORDER BY "id"`;

const AMBIGUOUS_KEYS = `
  SELECT count(*)::int AS n FROM (
    SELECT 1 FROM "patients"
     WHERE "deletedAt" IS NULL AND "docNumber" IS NOT NULL
     GROUP BY "tenantId", "docKey" HAVING count(*) > 1) s`;

const DOCS = ['1.111.111', '1111111', '1-111-111'];

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Plans?: PlanNode[];
}

const nodes = (plan: PlanNode): PlanNode[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(nodes),
];

describe('DX-327 · migraciones del tipo de documento genérico (int)', () => {
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let db: string;
  let dir: string;
  let target: PrismaClient;
  let before: SnapshotRow[];
  let lookupsBefore: string[][];
  let ambiguousBefore: number;
  let planBefore: PlanNode | undefined;
  /** Etiqueta antes y después de cada caso del trigger. */
  const labels: {
    name: string;
    before: string | null;
    after: string | null;
  }[] = [];

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

  async function lookups(): Promise<string[][]> {
    const out: string[][] = [];
    for (const doc of DOCS) {
      const rows = await asApp<{ id: string }>(T_X, LIVE_WITH_DOC, T_X, doc);
      out.push(rows.map((r) => r.id));
    }
    return out;
  }

  /** Nodo del plan de livePatientWithDoc que usa el índice parcial. */
  async function livePlan(): Promise<PlanNode | undefined> {
    const rows = await target.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE dentalix_app');
      // Con dos clínicas de juguete el planificador recorrería la tabla: se
      // comprueba que el índice SIGUE siendo utilizable, no su coste.
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      await tx.$queryRawUnsafe(
        `SELECT set_config('app.current_tenant', $1, true)`,
        T_X,
      );
      return tx.$queryRawUnsafe<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
        `EXPLAIN (FORMAT JSON) ${LIVE_WITH_DOC}`,
        T_X,
        '1.111.111',
      );
    });
    return nodes(rows[0]['QUERY PLAN'][0].Plan).find(
      (n) => n['Index Name'] === LIVE_IDX,
    );
  }

  async function ambiguous(): Promise<number> {
    const [row] = await target.$queryRawUnsafe<{ n: number }[]>(AMBIGUOUS_KEYS);
    return row.n;
  }

  async function typesOf(table: string, rowId: string): Promise<TypeRow> {
    const [row] = await target.$queryRawUnsafe<TypeRow[]>(
      `SELECT "docType"::text AS "docType", "documentType"::text AS "documentType",
              "docTypeLabel"
         FROM "${table}" WHERE "id" = $1::uuid`,
      rowId,
    );
    return row;
  }

  let seq = 0x80;
  /** Inserta una fila nueva de Y como la app; `columns` sustituye a la base. */
  async function insert(
    table: string,
    base: Record<string, string>,
    columns: Record<string, string>,
  ): Promise<string> {
    const rowId = id(T_Y, seq++);
    const row = { id: `'${rowId}'`, tenantId: `'${T_Y}'`, ...base, ...columns };
    await asApp(
      T_Y,
      `INSERT INTO "${table}" (${Object.keys(row)
        .map((n) => `"${n}"`)
        .join(', ')})
       VALUES (${Object.values(row).join(', ')}) RETURNING "id"`,
    );
    return rowId;
  }

  /** Un paciente nuevo en Y. */
  const insertPatient = (columns: Record<string, string>): Promise<string> =>
    insert(
      'patients',
      { firstName: `'Caso'`, lastName: `'Trigger'`, updatedAt: 'now()' },
      columns,
    );

  /** Un contacto responsable nuevo del paciente CC de Y. */
  const insertContact = (columns: Record<string, string>): Promise<string> =>
    insert(
      'patient_responsible_parties',
      {
        patientId: `'${id(T_Y, CC)}'`,
        fullName: `'Contacto ${seq}'`,
        relationship: `'OTHER'`,
        updatedAt: 'now()',
      },
      columns,
    );

  async function update(
    table: string,
    rowId: string,
    set: string,
  ): Promise<void> {
    await asApp(
      T_Y,
      `UPDATE "${table}" SET ${set} WHERE "id" = $1::uuid RETURNING "id"`,
      rowId,
    );
  }

  /** Registra la etiqueta de un caso para `the trigger never writes label text`. */
  function track(name: string, before: string | null, row: TypeRow): TypeRow {
    labels.push({ name, before, after: row.docTypeLabel });
    return row;
  }

  beforeAll(async () => {
    db = `dx327_mig_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'dx327-'));
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
    for (const name of all.filter((n) => n < DX327)) copy(name);
    migrateDeploy(dir, urlFor(db));
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    // La base desechable no hereda los privilegios por defecto de la de test.
    await target.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE ON "patients", "patient_responsible_parties" TO dentalix_app`,
    );
    for (const sql of SEED) await target.$executeRawUnsafe(sql);
    before = await target.$queryRawUnsafe<SnapshotRow[]>(SNAPSHOT);
    lookupsBefore = await lookups();
    ambiguousBefore = await ambiguous();
    planBefore = await livePlan();
    for (const name of all.filter((n) => n >= DX327)) copy(name);
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

  it('existing patients keep id, number, docKey and legacy code, and gain the generic type with no label', async () => {
    expect(before).toHaveLength(2 * 7 + 2 * 2);
    expect(await target.$queryRawUnsafe<SnapshotRow[]>(SNAPSHOT)).toEqual(
      before,
    );
    const types = await target.$queryRawUnsafe<TypeRow[]>(TYPES);
    expect(types).toHaveLength(before.length);
    expect(types).toEqual(
      types.map((row) => ({
        ...row,
        documentType: row.docType === null ? null : R3[row.docType],
        docTypeLabel: null,
      })),
    );
    // También el borrado, el que no tiene documento y los dos responsables.
    expect(await typesOf('patients', id(T_X, DELETED))).toEqual({
      docType: 'CC',
      documentType: 'NATIONAL_ID',
      docTypeLabel: null,
    });
    expect(await typesOf('patients', id(T_X, NO_DOC))).toEqual({
      docType: 'CC',
      documentType: 'NATIONAL_ID',
      docTypeLabel: null,
    });
    expect(
      await typesOf('patient_responsible_parties', id(T_Y, CONTACT)),
    ).toEqual({
      docType: 'TI',
      documentType: 'NATIONAL_ID',
      docTypeLabel: null,
    });
    expect(
      await typesOf(
        'patient_responsible_parties',
        id(T_Y, RESPONSIBLE_PATIENT),
      ),
    ).toEqual({ docType: null, documentType: null, docTypeLabel: null });
  });

  it('no DX-327 migration writes a document label', async () => {
    for (const name of DX327_MIGRATIONS) {
      const code = statements(name).join(';\n');
      const writes = [
        ...code.matchAll(
          /(?:SET\s+|NEW\.)"docTypeLabel"\s*:?=\s*([^\s;,)]+)/gi,
        ),
      ].map((m) => m[1].toUpperCase());
      expect({ name, writes: writes.filter((v) => v !== 'NULL') }).toEqual({
        name,
        writes: [],
      });
      expect(code).not.toMatch(/UPDATE[^;]*SET[^;]*"docTypeLabel"/i);
    }
    const [row] = await target.$queryRawUnsafe<{ p: number; r: number }[]>(
      `SELECT (SELECT count(*)::int FROM "patients" WHERE "docTypeLabel" IS NOT NULL) AS p,
              (SELECT count(*)::int FROM "patient_responsible_parties"
                WHERE "docTypeLabel" IS NOT NULL) AS r`,
    );
    expect(row).toEqual({ p: 0, r: 0 });
  });

  it('docKey dedupes the same after the DX-327 migrations', async () => {
    // «1.111.111» (CC) y «1111111» (TI) comparten clave: los dos, antes y
    // después, para las tres formas de escribirla.
    expect(lookupsBefore).toEqual(DOCS.map(() => [id(T_X, CC), id(T_X, TI)]));
    expect(await lookups()).toEqual(lookupsBefore);
    expect(ambiguousBefore).toBe(2);
    expect(await ambiguous()).toBe(ambiguousBefore);
    const plan = await livePlan();
    expect(planBefore?.['Index Cond']).toMatch(/"docKey" = /);
    expect(plan?.['Index Name']).toBe(LIVE_IDX);
    expect(plan?.['Index Cond']).toBe(planBefore?.['Index Cond']);
  });

  it('DocumentType has the five generic values in order and DocType is untouched', async () => {
    const labelsOf = async (name: string): Promise<string[]> =>
      (
        await target.$queryRawUnsafe<{ label: string }[]>(
          `SELECT e.enumlabel AS label FROM pg_enum e
             JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = $1
            ORDER BY e.enumsortorder`,
          name,
        )
      ).map((r) => r.label);
    expect(await labelsOf('DocumentType')).toEqual([
      'NATIONAL_ID',
      'PASSPORT',
      'RESIDENCE_PERMIT',
      'TAX_ID',
      'OTHER',
    ]);
    expect(await labelsOf('DocType')).toEqual([
      'CC',
      'TI',
      'CE',
      'PASSPORT',
      'OTHER',
    ]);
  });

  it('the backfill is one DO statement, idempotent and leaves no incoherent row', async () => {
    const body = statements(BACKFILL);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatch(/^DO \$\$/);
    const XMIN = `
      SELECT "id"::text AS id, xmin::text AS x FROM "patients"
      UNION ALL
      SELECT "id"::text, xmin::text FROM "patient_responsible_parties"
      ORDER BY 1`;
    const xminBefore = await target.$queryRawUnsafe<unknown[]>(XMIN);
    // Protocolo simple, fuera de una transacción: el COMMIT de cada lote solo
    // vale así (con $executeRawUnsafe falla, pre-flight M13).
    psql(db, ['-c', migrationSql(BACKFILL)]);
    expect(await target.$queryRawUnsafe<unknown[]>(XMIN)).toEqual(xminBefore);
    const [row] = await target.$queryRawUnsafe<{ n: number }[]>(
      `SELECT ((SELECT count(*) FROM "patients"
                 WHERE NOT public.dx_doc_type_coherent("docType", "documentType"))
             + (SELECT count(*) FROM "patient_responsible_parties"
                 WHERE NOT public.dx_doc_type_coherent("docType", "documentType")))::int AS n`,
    );
    expect(row.n).toBe(0);
  });

  it('M3 fails on an incoherent row or a written label', async () => {
    // Sobre la BD ya migrada M3 pasa (VALIDATE de un CHECK válido no hace nada).
    expect(() =>
      psql(db, [
        '-1',
        '-f',
        join(ROOT, 'prisma/migrations', VALIDATE, 'migration.sql'),
      ]),
    ).not.toThrow();
    const rowId = id(T_Y, 0x70);
    await target.$executeRawUnsafe(
      `ALTER TABLE "patients" DISABLE TRIGGER "patients_document_type"`,
    );
    try {
      await target.$executeRawUnsafe(
        `INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName",
                                 "docType", "documentType", "updatedAt")
         VALUES ('${rowId}', '${T_Y}', 'In', 'Coherente', 'CC', 'PASSPORT', now())`,
      );
    } finally {
      await target.$executeRawUnsafe(
        `ALTER TABLE "patients" ENABLE TRIGGER "patients_document_type"`,
      );
    }
    const m3 = (): void =>
      psql(db, [
        '-1',
        '-f',
        join(ROOT, 'prisma/migrations', VALIDATE, 'migration.sql'),
      ]);
    expect(m3).toThrow(/DX-327.*incoherente/);
    // La pareja coherente (el trigger la arregla al cambiar el genérico).
    await target.$executeRawUnsafe(
      `UPDATE "patients" SET "documentType" = 'NATIONAL_ID' WHERE "id" = '${rowId}'`,
    );
    expect(m3).not.toThrow();
    await target.$executeRawUnsafe(
      `UPDATE "patients" SET "docTypeLabel" = 'ID local' WHERE "id" = '${rowId}'`,
    );
    expect(m3).toThrow(/DX-327.*etiqueta/);
    await target.$executeRawUnsafe(
      `UPDATE "patient_responsible_parties" SET "docTypeLabel" = 'ID local'
        WHERE "id" = '${id(T_Y, CONTACT)}'`,
    );
    await target.$executeRawUnsafe(
      `UPDATE "patients" SET "docTypeLabel" = NULL WHERE "id" = '${rowId}'`,
    );
    expect(m3).toThrow(/DX-327.*etiqueta/);
    await target.$executeRawUnsafe(
      `UPDATE "patient_responsible_parties" SET "docTypeLabel" = NULL
        WHERE "id" = '${id(T_Y, CONTACT)}'`,
    );
    expect(m3).not.toThrow();
  });

  it('M3 sets the clinic in each pass and sees every clinic under FORCE', async () => {
    // El owner de producción no tiene BYPASSRLS: la comprobación de M3 corre
    // aquí como dentalix_app (sujeto a la RLS), que sin `app.current_tenant`
    // no vería ninguna fila y daría por buena una BD incoherente.
    const check = statements(VALIDATE).find((st) => st.startsWith('DO $$'));
    expect(check).toBeDefined();
    await target.$executeRawUnsafe(`GRANT SELECT ON "tenants" TO dentalix_app`);
    const asAppM3 = (): void =>
      psql(db, ['-1', '-c', 'SET ROLE dentalix_app', '-c', check as string]);
    expect(asAppM3).not.toThrow();
    const rows = { [T_X]: id(T_X, 0x71), [T_Y]: id(T_Y, 0x71) };
    await target.$executeRawUnsafe(
      `ALTER TABLE "patients" DISABLE TRIGGER "patients_document_type"`,
    );
    try {
      for (const [tenant, rowId] of Object.entries(rows)) {
        await target.$executeRawUnsafe(
          `INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName",
                                   "docType", "documentType", "updatedAt")
           VALUES ('${rowId}', '${tenant}', 'In', 'Coherente', 'CC', 'PASSPORT', now())`,
        );
      }
    } finally {
      await target.$executeRawUnsafe(
        `ALTER TABLE "patients" ENABLE TRIGGER "patients_document_type"`,
      );
    }
    const fix = (rowId: string): Promise<number> =>
      target.$executeRawUnsafe(
        `UPDATE "patients" SET "documentType" = 'NATIONAL_ID' WHERE "id" = '${rowId}'`,
      );
    // X va primero; arreglada X, la de Y también se ve (otra clínica, otra
    // pasada con su `app.current_tenant`).
    expect(asAppM3).toThrow(new RegExp(`DX-327.*incoherente.*${T_X}`));
    await fix(rows[T_X]);
    expect(asAppM3).toThrow(new RegExp(`DX-327.*incoherente.*${T_Y}`));
    await fix(rows[T_Y]);
    expect(asAppM3).not.toThrow();
  });

  it('migrations shape', async () => {
    const m1 = statements(DX327);
    expect(m1[0]).toBe(`SET LOCAL lock_timeout = '5s'`);
    const m1Sql = m1.join(';\n');
    expect(m1Sql).not.toMatch(/ALTER\s+TYPE\s+"DocType"/i);
    const checks = m1.filter((s) => /ADD CONSTRAINT/i.test(s));
    expect(checks.map((s) => s.match(/ADD CONSTRAINT "([^"]+)"/)?.[1])).toEqual(
      [
        'patients_doc_type_label_check',
        'patient_responsible_parties_doc_type_label_check',
        'patient_responsible_parties_document_type_check',
      ],
    );
    for (const s of checks) expect(s).toMatch(/NOT VALID$/);
    // M2: cada lote (pacientes y responsables) fija su clínica y su
    // lock_timeout tras cada COMMIT.
    const m2 = statements(BACKFILL)[0];
    expect(m2.match(/COMMIT;/g)).toHaveLength(2);
    expect(
      m2.match(/pg_catalog\.set_config\('lock_timeout', '5s', true\)/g),
    ).toHaveLength(2);
    expect(
      m2.match(
        /pg_catalog\.set_config\('app\.current_tenant', t::text, true\)/g,
      ),
    ).toHaveLength(2);
    const m3 = statements(VALIDATE);
    expect(m3[0]).toBe(`SET LOCAL lock_timeout = '5s'`);
    expect(
      m3
        .filter((s) => /VALIDATE CONSTRAINT/i.test(s))
        .map((s) => s.match(/VALIDATE CONSTRAINT "([^"]+)"/)?.[1]),
    ).toEqual([
      'patients_doc_type_label_check',
      'patient_responsible_parties_doc_type_label_check',
      'patient_responsible_parties_document_type_check',
    ]);
    const validated = await target.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint
        WHERE conname IN ('patients_doc_type_label_check',
                          'patient_responsible_parties_doc_type_label_check',
                          'patient_responsible_parties_document_type_check')
          AND convalidated
        ORDER BY 1`,
    );
    expect(validated).toHaveLength(3);
    const functions = await target.$queryRawUnsafe<
      { name: string; config: string[] | null }[]
    >(
      `SELECT p.proname AS name, p.proconfig AS config FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('dx_doc_type_from_legacy', 'dx_doc_type_to_legacy',
                            'dx_doc_type_coherent', 'dx_document_type_sync')
        ORDER BY 1`,
    );
    expect(functions).toEqual(
      [
        'dx_doc_type_coherent',
        'dx_doc_type_from_legacy',
        'dx_doc_type_to_legacy',
        'dx_document_type_sync',
      ].map((name) => ({ name, config: ['search_path=pg_catalog, pg_temp'] })),
    );
    // Ninguna función de etiqueta: ningún código antiguo da etiqueta (R3).
    const [labelFn] = await target.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'dx_doc_type%label%'`,
    );
    expect(labelFn.n).toBe(0);
    for (const name of DX327_MIGRATIONS) {
      expect(migrationSql(name)).toMatch(
        /^-- Excepción G5\.3 \(DX-334\): tipos de documento anteriores a DX-327\./,
      );
      expect(migrationSql(name)).not.toMatch(
        /[Cc][ée]dula|[Tt]arjeta|[Ee]xtranjer/,
      );
    }
    const triggers = await target.$queryRawUnsafe<{ t: string }[]>(
      `SELECT tgrelid::regclass::text || ':' || tgname AS t FROM pg_trigger
        WHERE tgname IN ('patients_document_type',
                         'patient_responsible_parties_document_type')
        ORDER BY 1`,
    );
    expect(triggers.map((r) => r.t)).toEqual([
      'patient_responsible_parties:patient_responsible_parties_document_type',
      'patients:patients_document_type',
    ]);
  });

  it('the label CHECK takes 1–40 trimmed characters', async () => {
    const label = (value: string): Promise<string> =>
      insertPatient({
        docType: `'OTHER'`,
        documentType: `'OTHER'`,
        docTypeLabel: `'${value}'`,
      });
    await expect(label('')).rejects.toThrow(/patients_doc_type_label_check/);
    await expect(label(' x')).rejects.toThrow(/patients_doc_type_label_check/);
    await expect(label('x'.repeat(41))).rejects.toThrow(
      /patients_doc_type_label_check/,
    );
    const ok = await label('x'.repeat(40));
    expect((await typesOf('patients', ok)).docTypeLabel).toHaveLength(40);
    await expect(
      insertContact({ docTypeLabel: `' x '`, documentType: `'OTHER'` }),
    ).rejects.toThrow(/patient_responsible_parties_doc_type_label_check/);
  });

  describe('trigger (spec §3.3, un caso por fila)', () => {
    it('legacy old-API insert TI gets NATIONAL_ID and no label', async () => {
      const p = await insertPatient({ docType: `'TI'`, docNumber: `'RX-T01'` });
      expect(track('TI', null, await typesOf('patients', p))).toEqual({
        docType: 'TI',
        documentType: 'NATIONAL_ID',
        docTypeLabel: null,
      });
    });

    it('legacy old-API insert OTHER stays OTHER with no label', async () => {
      const p = await insertPatient({ docType: `'OTHER'` });
      expect(track('OTHER', null, await typesOf('patients', p))).toEqual({
        docType: 'OTHER',
        documentType: 'OTHER',
        docTypeLabel: null,
      });
    });

    it('a new-API insert of TAX_ID with its legacy projection is kept as written', async () => {
      const p = await insertPatient({
        docType: `'OTHER'`,
        documentType: `'TAX_ID'`,
        docTypeLabel: `'ID local'`,
      });
      expect(track('TAX_ID', 'ID local', await typesOf('patients', p))).toEqual(
        {
          docType: 'OTHER',
          documentType: 'TAX_ID',
          docTypeLabel: 'ID local',
        },
      );
      // Una pareja coherente que no es la proyección (TI) también se queda.
      const q = await insertPatient({
        docType: `'TI'`,
        documentType: `'NATIONAL_ID'`,
      });
      expect(track('TI escrito', null, await typesOf('patients', q))).toEqual({
        docType: 'TI',
        documentType: 'NATIONAL_ID',
        docTypeLabel: null,
      });
    });

    it('a new-API insert of PASSPORT without the legacy code gets its projection', async () => {
      const p = await insertPatient({ documentType: `'PASSPORT'` });
      expect(track('PASSPORT', null, await typesOf('patients', p))).toEqual({
        docType: 'PASSPORT',
        documentType: 'PASSPORT',
        docTypeLabel: null,
      });
    });

    it('legacy hole: a new-API insert of OTHER without the legacy code reads as the legacy default', async () => {
      // Con DEFAULT 'CC' y DEFAULT 'OTHER' parece un escritor anterior: el
      // trigger no puede distinguirlo. Por eso la API nueva escribe la
      // pareja en cada INSERT (R5).
      const p = await insertPatient({ documentType: `'OTHER'` });
      expect(track('hueco', null, await typesOf('patients', p))).toEqual({
        docType: 'CC',
        documentType: 'NATIONAL_ID',
        docTypeLabel: null,
      });
    });

    it('documented behaviour: an incoherent insert with OTHER reads as an older writer, takes the legacy type and keeps its label', async () => {
      // Paso 3 del INSERT: con "documentType" = 'OTHER' (el DEFAULT) y una
      // pareja incoherente, manda el antiguo; la etiqueta no se toca. La API
      // nueva nunca escribe esta pareja (R5, `satisfies`).
      const p = await insertPatient({
        docType: `'PASSPORT'`,
        documentType: `'OTHER'`,
        docTypeLabel: `'ID local'`,
      });
      expect(
        track('hueco con etiqueta', 'ID local', await typesOf('patients', p)),
      ).toEqual({
        docType: 'PASSPORT',
        documentType: 'PASSPORT',
        docTypeLabel: 'ID local',
      });
    });

    it('a raw insert with no type gets NATIONAL_ID and no label', async () => {
      const p = await insertPatient({});
      expect(track('sin tipo', null, await typesOf('patients', p))).toEqual({
        docType: 'CC',
        documentType: 'NATIONAL_ID',
        docTypeLabel: null,
      });
    });

    it('a new-API change NATIONAL_ID → PASSPORT rewrites the legacy code', async () => {
      const p = await insertPatient({ docType: `'TI'` });
      await update('patients', p, `"documentType" = 'PASSPORT'`);
      expect(track('→PASSPORT', null, await typesOf('patients', p))).toEqual({
        docType: 'PASSPORT',
        documentType: 'PASSPORT',
        docTypeLabel: null,
      });
    });

    it('legacy TI stays TI when the generic type does not change', async () => {
      const p = await insertPatient({ docType: `'TI'` });
      await update(
        'patients',
        p,
        `"documentType" = 'NATIONAL_ID', "docTypeLabel" = 'ID local'`,
      );
      expect(
        track('TI igual', 'ID local', await typesOf('patients', p)),
      ).toEqual({
        docType: 'TI',
        documentType: 'NATIONAL_ID',
        docTypeLabel: 'ID local',
      });
    });

    it("legacy old-API change CC → TI keeps NATIONAL_ID and the clinic's label", async () => {
      const p = await insertPatient({
        docType: `'CC'`,
        documentType: `'NATIONAL_ID'`,
        docTypeLabel: `'ID local'`,
      });
      await update('patients', p, `"docType" = 'TI'`);
      expect(track('CC→TI', 'ID local', await typesOf('patients', p))).toEqual({
        docType: 'TI',
        documentType: 'NATIONAL_ID',
        docTypeLabel: 'ID local',
      });
    });

    it("legacy old-API change CC → PASSPORT clears the clinic's label", async () => {
      const p = await insertPatient({
        docType: `'CC'`,
        documentType: `'NATIONAL_ID'`,
        docTypeLabel: `'ID local'`,
      });
      await update('patients', p, `"docType" = 'PASSPORT'`);
      expect(
        track('CC→PASSPORT', 'ID local', await typesOf('patients', p)),
      ).toEqual({
        docType: 'PASSPORT',
        documentType: 'PASSPORT',
        docTypeLabel: null,
      });
    });

    it('contacts: a new-API OTHER gets its legacy code', async () => {
      const c = await insertContact({ documentType: `'OTHER'` });
      expect(
        track(
          'contacto OTHER',
          null,
          await typesOf('patient_responsible_parties', c),
        ),
      ).toEqual({
        docType: 'OTHER',
        documentType: 'OTHER',
        docTypeLabel: null,
      });
    });

    it('contacts: an old-API type removal clears type and label', async () => {
      const c = await insertContact({
        documentType: `'TAX_ID'`,
        docTypeLabel: `'ID local'`,
      });
      expect(await typesOf('patient_responsible_parties', c)).toEqual({
        docType: 'OTHER',
        documentType: 'TAX_ID',
        docTypeLabel: 'ID local',
      });
      await update('patient_responsible_parties', c, `"docType" = NULL`);
      expect(
        track(
          'contacto sin tipo',
          'ID local',
          await typesOf('patient_responsible_parties', c),
        ),
      ).toEqual({ docType: null, documentType: null, docTypeLabel: null });
    });

    it('contacts: a new-API type removal clears the legacy code and the label', async () => {
      const c = await insertContact({
        documentType: `'PASSPORT'`,
        docTypeLabel: `'ID local'`,
      });
      await update('patient_responsible_parties', c, `"documentType" = NULL`);
      expect(
        track(
          'contacto sin tipo (nueva)',
          'ID local',
          await typesOf('patient_responsible_parties', c),
        ),
      ).toEqual({ docType: null, documentType: null, docTypeLabel: null });
    });

    it('an UPDATE that sets both columns keeps the generic one (step 1)', async () => {
      const p = await insertPatient({ documentType: `'PASSPORT'` });
      await update(
        'patients',
        p,
        `"docType" = 'CE', "documentType" = 'TAX_ID'`,
      );
      expect(track('las dos', null, await typesOf('patients', p))).toEqual({
        docType: 'OTHER',
        documentType: 'TAX_ID',
        docTypeLabel: null,
      });
      // Si la pareja que llega es coherente, el antiguo se queda como vino.
      await update(
        'patients',
        p,
        `"docType" = 'TI', "documentType" = 'NATIONAL_ID'`,
      );
      expect(track('las dos (TI)', null, await typesOf('patients', p))).toEqual(
        {
          docType: 'TI',
          documentType: 'NATIONAL_ID',
          docTypeLabel: null,
        },
      );
    });

    it('legacy old-API rewrite of the same code keeps TAX_ID and the label', async () => {
      // El diálogo de contacto anterior reenvía siempre el tipo: OTHER → OTHER.
      const c = await insertContact({
        documentType: `'TAX_ID'`,
        docTypeLabel: `'ID local'`,
      });
      await update('patient_responsible_parties', c, `"docType" = 'OTHER'`);
      expect(
        track(
          'mismo código',
          'ID local',
          await typesOf('patient_responsible_parties', c),
        ),
      ).toEqual({
        docType: 'OTHER',
        documentType: 'TAX_ID',
        docTypeLabel: 'ID local',
      });
      const p = await insertPatient({
        docType: `'OTHER'`,
        documentType: `'TAX_ID'`,
        docTypeLabel: `'ID local'`,
      });
      await update('patients', p, `"docType" = 'OTHER'`);
      expect(
        track(
          'mismo código (paciente)',
          'ID local',
          await typesOf('patients', p),
        ),
      ).toEqual({
        docType: 'OTHER',
        documentType: 'TAX_ID',
        docTypeLabel: 'ID local',
      });
    });

    it('a new-API change OTHER ↔ TAX_ID leaves the legacy OTHER untouched', async () => {
      const p = await insertPatient({
        docType: `'OTHER'`,
        documentType: `'OTHER'`,
      });
      await update('patients', p, `"documentType" = 'TAX_ID'`);
      expect(track('OTHER→TAX_ID', null, await typesOf('patients', p))).toEqual(
        {
          docType: 'OTHER',
          documentType: 'TAX_ID',
          docTypeLabel: null,
        },
      );
      await update('patients', p, `"documentType" = 'OTHER'`);
      expect(track('TAX_ID→OTHER', null, await typesOf('patients', p))).toEqual(
        {
          docType: 'OTHER',
          documentType: 'OTHER',
          docTypeLabel: null,
        },
      );
    });

    it('a patient responsible has no type or label (CHECK)', async () => {
      const responsible = (columns: Record<string, string>): Promise<string> =>
        insertContact({
          fullName: 'NULL',
          responsiblePatientId: `'${id(T_Y, OTHER)}'`,
          ...columns,
        });
      await expect(responsible({ docTypeLabel: `'ID local'` })).rejects.toThrow(
        /patient_responsible_parties_document_type_check/,
      );
      await expect(responsible({ documentType: `'OTHER'` })).rejects.toThrow(
        /patient_responsible_parties_document_type_check/,
      );
      // Etiqueta sin tipo en un contacto: tampoco.
      await expect(
        insertContact({ docTypeLabel: `'ID local'` }),
      ).rejects.toThrow(/patient_responsible_parties_document_type_check/);
      const ok = await responsible({});
      expect(
        track(
          'responsable paciente',
          null,
          await typesOf('patient_responsible_parties', ok),
        ),
      ).toEqual({ docType: null, documentType: null, docTypeLabel: null });
    });

    it('the trigger never writes label text', () => {
      expect(labels.length).toBeGreaterThanOrEqual(16);
      const written = labels.filter(
        (l) => l.after !== null && l.after !== l.before,
      );
      expect(written).toEqual([]);
    });
  });

  it('patients and patient_responsible_parties keep FORCE row level security', async () => {
    const rows = await target.$queryRawUnsafe<{ t: string; forced: boolean }[]>(
      `SELECT relname AS t, relforcerowsecurity AS forced FROM pg_class
        WHERE oid IN ('public.patients'::regclass,
                      'public.patient_responsible_parties'::regclass)
        ORDER BY 1`,
    );
    expect(rows).toEqual([
      { t: 'patient_responsible_parties', forced: true },
      { t: 'patients', forced: true },
    ]);
  });
});
