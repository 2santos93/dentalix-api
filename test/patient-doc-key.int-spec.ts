import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { docKey } from '../src/modules/patients/domain/doc-key';
import { DOC_KEY_CASES } from '../src/modules/patients/domain/__fixtures__/doc-key-cases';
import {
  livePatientWithDoc,
  livePatientWithDocSql,
} from '../src/modules/patients/infrastructure/patient-doc-lock';
import {
  balancePatientsByDocSql,
  existingBalancesByDocSql,
  existingDocsSql,
  knownDocsPatientsSql,
  patientsToFillByDocSql,
} from '../src/modules/patient-imports/infrastructure/patient-doc-queries';
import {
  BALANCE_CHUNK_SIZE,
  IMPORT_CHUNK_SIZE,
} from '../src/modules/patient-imports/application/patient-import-jobs';
import { resetDatabase } from './support/e2e-fixtures';

// DX-287 (DB-047): clave de documento normalizada en una columna indexada.
//   - public.dx_doc_key y el trigger patients_doc_key dan EXACTAMENTE la
//     clave de docKey() (doc-key.ts), también fuera de ASCII;
//   - las consultas reales del alta manual y de la importación (las funciones
//     *Sql exportadas), explicadas como dentalix_app con la clínica fijada y
//     RLS FORCE, entran por patients_tenant_doc_key_live_idx: ni Seq Scan de
//     patients ni filas descartadas por un Filter.
// `raw` (DIRECT_URL, owner) solo siembra, lee y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const INDEX = 'patients_tenant_doc_key_live_idx';
/**
 * Pacientes con documento en la clínica A (con puntos, como en Colombia):
 * el volumen del criterio de DX-287. Con muchos menos, el planificador puede
 * preferir, con razón, recorrer una tabla pequeña con 250 claves.
 */
const VOLUME = 60_000;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Filter?: string;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
}

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

/** EXPLAIN (ANALYZE, FORMAT JSON) como dentalix_app con la clínica fijada. */
async function explain(tenantId: string, sql: Prisma.Sql): Promise<PlanNode[]> {
  const rows = await prisma.runWithTenant(tenantId, (tx) =>
    tx.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
      Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
    ),
  );
  return nodes(rows[0]['QUERY PLAN'][0].Plan);
}

/** El nodo que lee patients por el índice nuevo; falla si hay Seq Scan. */
function patientsAccess(plan: PlanNode[]): PlanNode {
  const onPatients = plan.filter(
    (n) => n['Relation Name'] === 'patients' || n['Index Name'] === INDEX,
  );
  expect(onPatients.map((n) => n['Node Type'])).not.toContain('Seq Scan');
  const hit = onPatients.find((n) => n['Index Name'] === INDEX);
  expect(hit).toBeDefined();
  expect(hit?.['Index Cond']).toMatch(/"tenantId" = /);
  expect(hit?.['Index Cond']).toMatch(/"docKey" = /);
  // Nada de recorrer la clínica descartando filas por la expresión.
  const removed = onPatients.reduce(
    (sum, n) =>
      sum +
      (n['Rows Removed by Filter'] ?? 0) +
      (n['Rows Removed by Index Recheck'] ?? 0),
    0,
  );
  expect(removed).toBe(0);
  const filters = onPatients.map((n) => n.Filter ?? '').join(' ');
  expect(filters).not.toMatch(/regexp_replace|upper|dx_doc_key/);
  return hit as PlanNode;
}

async function clinic(subdomain: string): Promise<string> {
  const t = await raw.tenant.create({ data: { name: subdomain, subdomain } });
  return t.id;
}

/** n-ésimo documento de la siembra, con puntos de miles: «10.000.123». */
const seededDoc = (n: number) => {
  const s = String(10_000_000 + n);
  return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5)}`;
};

/** n claves de documentos sembrados en A, repartidas por toda la clínica. */
const keysOf = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    String(10_000_000 + 1 + ((i * 37) % VOLUME)),
  );

describe('DX-287 · patients."docKey" indexada (int)', () => {
  let a: string;
  let b: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(raw);
    a = await clinic('dx287-a');
    b = await clinic('dx287-b');
    // Siembra por SQL: el trigger calcula "docKey" en cada INSERT.
    await raw.$executeRawUnsafe(`
      INSERT INTO "patients" ("id","tenantId","firstName","lastName","docNumber","updatedAt")
      SELECT gen_random_uuid(), '${a}', 'P' || n, 'Volumen',
             substr(s, 1, 2) || '.' || substr(s, 3, 3) || '.' || substr(s, 6), now()
        FROM generate_series(1, ${VOLUME}) AS n
        CROSS JOIN LATERAL (SELECT (10000000 + n)::text AS s) d`);
    // Los mismos documentos en B (no deben verse desde A) y unos sin documento.
    await raw.$executeRawUnsafe(`
      INSERT INTO "patients" ("id","tenantId","firstName","lastName","docNumber","updatedAt")
      SELECT gen_random_uuid(), '${b}', 'Q' || n, 'Otra',
             CASE WHEN n <= 200 THEN (10000000 + n)::text END, now()
        FROM generate_series(1, 400) AS n`);
    await raw.$executeRawUnsafe('ANALYZE "patients"');
  }, 300_000);

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  describe('la clave de la BD es la de docKey()', () => {
    it('public.dx_doc_key coincide con docKey() en los casos del dominio', async () => {
      const inputs = DOC_KEY_CASES.map(([input]) => input);
      const rows = await raw.$queryRaw<{ k: string | null }[]>`
        SELECT public.dx_doc_key(u.d) AS k
          FROM unnest(${inputs}::text[]) WITH ORDINALITY AS u(d, i)
         ORDER BY u.i`;
      expect(rows.map((r) => r.k)).toEqual(
        DOC_KEY_CASES.map(([, expected]) => expected),
      );
      expect(rows.map((r) => r.k)).toEqual(inputs.map(docKey));
    });

    it('y en 3.000 textos al azar con puntuación, minúsculas y Unicode (incluidos los que JS y glibc pasan a ASCII)', async () => {
      const alphabet = [
        ...'0123456789abcxyzABCXYZ .-/_,;:\t\n',
        ...'ñÑéÉüßẞﬁﬂıİſǅǰŉΩωКк１２ＡａⅠ€',
      ];
      let seed = 287;
      const next = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed;
      };
      const inputs = Array.from({ length: 3_000 }, () =>
        Array.from(
          { length: next() % 16 },
          () => alphabet[next() % alphabet.length],
        ).join(''),
      );
      const rows = await raw.$queryRaw<{ k: string }[]>`
        SELECT public.dx_doc_key(u.d) AS k
          FROM unnest(${inputs}::text[]) WITH ORDINALITY AS u(d, i)
         ORDER BY u.i`;
      const mismatches = inputs
        .map((input, i) => [input, rows[i].k, docKey(input)])
        .filter(([, sql, js]) => sql !== js);
      expect(mismatches).toEqual([]);
    });

    it('el trigger la calcula al dar de alta por la app (dentalix_app, RLS) y NULL sin documento', async () => {
      const created = await prisma.runWithTenant(a, async (tx) => {
        const ids: string[] = [];
        for (const [input] of DOC_KEY_CASES) {
          const p = await tx.patient.create({
            data: {
              tenantId: a,
              firstName: 'Caso',
              lastName: 'Trigger',
              docNumber: input,
            },
          });
          ids.push(p.id);
        }
        const none = await tx.patient.create({
          data: { tenantId: a, firstName: 'Sin', lastName: 'Documento' },
        });
        return { ids, none: none.id };
      });
      const rows = await raw.$queryRaw<
        { id: string; docNumber: string; docKey: string }[]
      >`
        SELECT "id", "docNumber", "docKey" FROM "patients"
         WHERE "id" = ANY(${created.ids}::uuid[])`;
      expect(rows).toHaveLength(DOC_KEY_CASES.length);
      for (const r of rows) expect(r.docKey).toBe(docKey(r.docNumber));
      const [none] = await raw.$queryRaw<{ docKey: string | null }[]>`
        SELECT "docKey" FROM "patients" WHERE "id" = ${created.none}::uuid`;
      expect(none.docKey).toBeNull();
      await raw.patient.deleteMany({
        where: { id: { in: [...created.ids, created.none] } },
      });
    });

    it('al cambiar el documento se recalcula; un valor escrito a mano se sobrescribe', async () => {
      const p = await raw.patient.create({
        data: {
          tenantId: a,
          firstName: 'Cambia',
          lastName: 'Documento',
          docNumber: '77.777',
        },
      });
      const keyOf = async () =>
        (
          await raw.$queryRaw<{ k: string | null }[]>`
            SELECT "docKey" AS k FROM "patients" WHERE "id" = ${p.id}::uuid`
        )[0].k;
      expect(await keyOf()).toBe('77777');
      await prisma.runWithTenant(a, (tx) =>
        tx.patient.update({
          where: { id: p.id },
          data: { docNumber: 'x-88.8' },
        }),
      );
      expect(await keyOf()).toBe('X888');
      await prisma.runWithTenant(
        a,
        (tx) => tx.$executeRaw`
          UPDATE "patients" SET "docKey" = 'OTRA' WHERE "id" = ${p.id}::uuid`,
      );
      expect(await keyOf()).toBe('X888');
      await prisma.runWithTenant(a, (tx) =>
        tx.patient.update({ where: { id: p.id }, data: { docNumber: null } }),
      );
      expect(await keyOf()).toBeNull();
      await raw.patient.delete({ where: { id: p.id } });
    });

    it('ningún paciente sembrado queda sin clave ni con otra distinta de la regla', async () => {
      const docs = await raw.$queryRaw<
        { docNumber: string; docKey: string | null }[]
      >`
        SELECT "docNumber", "docKey" FROM "patients"
         WHERE "docNumber" IS NOT NULL
         ORDER BY random() LIMIT 500`;
      expect(docs).toHaveLength(500);
      expect(docs.filter((d) => d.docKey !== docKey(d.docNumber))).toEqual([]);
    });
  });

  describe('índice parcial y planes bajo RLS (dentalix_app)', () => {
    it('el índice existe, es válido y su predicado es el de las consultas', async () => {
      const [idx] = await raw.$queryRaw<{ valid: boolean; def: string }[]>`
        SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
          FROM pg_index i
         WHERE i.indexrelid = 'public.patients_tenant_doc_key_live_idx'::regclass`;
      expect(idx.valid).toBe(true);
      expect(idx.def).toMatch(/\("tenantId", "docKey"\)/);
      expect(idx.def).toMatch(
        /WHERE \(\("deletedAt" IS NULL\) AND \("docNumber" IS NOT NULL\)\)/,
      );
    });

    it('livePatientWithDoc (alta y edición manual): Index Cond sobre "docKey", sin Seq Scan', async () => {
      const plan = await explain(a, livePatientWithDocSql(a, '10000123'));
      const hit = patientsAccess(plan);
      expect(hit['Actual Rows']).toBe(1);
    });

    it(`applyRows (bloque de ${IMPORT_CHUNK_SIZE} con FOR UPDATE): Index Cond con = ANY, sin Seq Scan`, async () => {
      const plan = await explain(
        a,
        patientsToFillByDocSql(a, keysOf(IMPORT_CHUNK_SIZE)),
      );
      const hit = patientsAccess(plan);
      expect((hit['Actual Rows'] ?? 0) * (hit['Actual Loops'] ?? 1)).toBe(
        IMPORT_CHUNK_SIZE,
      );
      expect(plan.map((n) => n['Node Type'])).toContain('LockRows');
    });

    it.each([
      ['existingDocs (dry-run)', existingDocsSql],
      ['knownDocs (hoja de saldos)', knownDocsPatientsSql],
      ['processBalanceChunk', balancePatientsByDocSql],
    ])(
      '%s con un bloque de saldos: Index Cond sobre "docKey", sin Seq Scan',
      async (_label, build) => {
        patientsAccess(await explain(a, build(a, keysOf(BALANCE_CHUNK_SIZE))));
      },
    );

    it('existingBalances con un bloque de saldos: sin Seq Scan de patients ni la expresión en Filter', async () => {
      const plan = await explain(
        a,
        existingBalancesByDocSql(
          a,
          a,
          keysOf(BALANCE_CHUNK_SIZE),
          'America/Bogota',
        ),
      );
      const onPatients = plan.filter((n) => n['Relation Name'] === 'patients');
      expect(onPatients.map((n) => n['Node Type'])).not.toContain('Seq Scan');
      expect(plan.map((n) => n.Filter ?? '').join(' ')).not.toMatch(
        /regexp_replace|upper/,
      );
    });
  });

  describe('comportamiento', () => {
    it('encuentra el documento escrito distinto, solo vivo, solo en la clínica y sin el propio paciente', async () => {
      const found = await prisma.runWithTenant(a, (tx) =>
        livePatientWithDoc(tx, a, '10-000-123'),
      );
      expect(found).not.toBeNull();
      const [own] = await raw.$queryRaw<{ docNumber: string }[]>`
        SELECT "docNumber" FROM "patients" WHERE "id" = ${found}::uuid`;
      expect(own.docNumber).toBe(seededDoc(123));
      expect(
        await prisma.runWithTenant(a, (tx) =>
          livePatientWithDoc(tx, a, '10.000.123', found as string),
        ),
      ).toBeNull();
      // B tiene «10000123» sin puntos: desde A no se ve y desde B sí.
      const inB = await prisma.runWithTenant(b, (tx) =>
        livePatientWithDoc(tx, b, '10.000.123'),
      );
      expect(inB).not.toBeNull();
      expect(inB).not.toBe(found);
      // Retirado en blando: deja de contar.
      await raw.patient.update({
        where: { id: found as string },
        data: { deletedAt: new Date() },
      });
      expect(
        await prisma.runWithTenant(a, (tx) =>
          livePatientWithDoc(tx, a, '10000123'),
        ),
      ).toBeNull();
      // Sin letras ni dígitos no busca nada.
      expect(
        await prisma.runWithTenant(a, (tx) => livePatientWithDoc(tx, a, '.-.')),
      ).toBeNull();
    });
  });
});
