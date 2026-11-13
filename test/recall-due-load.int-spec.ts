import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  PrismaRecallRepository,
  recallDueSql,
  recallUnconfiguredSql,
  type RecallDueSqlParams,
  type RecallUnconfiguredSqlParams,
} from '../src/modules/recall/infrastructure/prisma-recall.repository';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';
import { seedDefaultRecallTypes } from './support/recall-types';

// DX-015-bis (criterio de 500 ms): la lista de recall y su recuento («Mi día»)
// en una clínica con 60.000 pacientes, 2 sedes en zonas distintas (Caracas y
// Kiritimati, UTC+14), ~90.000 recalls de los 3 tipos por defecto (~20 %
// vencidos), ~10 % de pacientes con cita futura, 3 citas atendidas por
// paciente (la LATERAL de la sede) y una segunda clínica de ruido. VACUUM
// ANALYZE al final (lo que deja el autovacuum en una base viva: estadísticas
// y el mapa de visibilidad de los recorridos solo de índice). EXPLAIN ANALYZE como dentalix_app (runWithTenant, RLS) de
// `recallDueSql` y, de punta a punta, `PrismaRecallRepository.listDue`: la
// mediana de 7 corridas tras 2 de calentamiento, por debajo del presupuesto,
// una sola lectura de patient_recalls que, sin Seq Scan, va por un índice de
// la clínica (ver `indexPlan` y el `it.each`). `raw` (DIRECT_URL,
// owner) siembra y limpia. Sin "patientCode" en los INSERT: lo pone el
// trigger (DX-484). Las cifras medidas se imprimen (informe de DX-015-bis).
//
// Porción 3 (D17): «Sin recall configurado» con la MISMA siembra más 6.000
// pacientes atendidos sin ningún recall (~10 % con cita futura), medida igual
// (`recallUnconfiguredSql` y `listUnconfigured`), su total contra una consulta
// de referencia ingenua y, al final, el peor caso: la clínica sin ningún
// recall (aún no lo usa: ~60.000 candidatos que ordenar).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repository = new PrismaRecallRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx015bis-load', 'dx015bis-load-ruido'];
const PATIENTS = 60_000;
/** D17: atendidos sin ningún recall, además de los 60.000. */
const UNCONFIGURED = 6_000;
const NOISE_PATIENTS = 10_000;
const BUDGET_MS = 500;
const NOW = new Date('2027-04-10T15:00:00.000Z');
const WARMUP = 2;
const RUNS = 7;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Plans?: PlanNode[];
}

const flatten = (plan: PlanNode): PlanNode[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(flatten),
];
const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

interface Clinic {
  tenantId: string;
  sedes: [string, string];
}

/**
 * La clínica con `patients` pacientes. Recalls por paciente n: Higiene si
 * n % 4 ≠ 0 (6 meses), Mantenimiento periodontal si n % 4 = 0 (3 meses, el
 * mismo grupo de exclusión), Control si n es par (12 meses): 1,5 por
 * paciente. La base retrocede un número de días repartido para que ~20 %
 * venza. Una cita futura agendada para n % 10 = 0 y 3 atendidas para todos.
 */
async function seedClinic(
  subdomain: string,
  patients: number,
): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const sede = async (name: string, timeZone: string) =>
    (
      await raw.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, {
          tenantId,
          name,
          timeZone,
        }),
      })
    ).id;
  const sedes: [string, string] = [
    await sede('Sede Chacao', 'America/Caracas'),
    await sede('Sede Kiritimati', 'Pacific/Kiritimati'),
  ];
  const types = await seedDefaultRecallTypes(raw, tenantId);

  await raw.$executeRaw`
    INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName", "phone", "updatedAt")
    SELECT gen_random_uuid(), ${tenantId}::uuid, 'Paciente', 'Carga ' || g,
           '+58 412 555 ' || lpad((g % 10000)::text, 4, '0'), now()
      FROM generate_series(1, ${patients}::int) AS g`;
  // Numerados por orden de id (estable): n decide sus recalls y citas.
  const numbered = Prisma.sql`(
    SELECT "id", row_number() OVER (ORDER BY "id")::int AS n
      FROM "patients" WHERE "tenantId" = ${tenantId}::uuid
  ) p`;

  const author = '00000000-0000-4000-8000-0000000015b1';
  // lastDoneAt = hoy − (hash mod ventana) días, ventana = intervalo / 0,8:
  // ~20 % pasa del intervalo (vencido). Sede: la par o impar.
  const recalls = (typeId: string, months: number, where: Prisma.Sql) =>
    raw.$executeRaw`
      INSERT INTO "patient_recalls"
        ("id", "tenantId", "patientId", "recallTypeId", "kind", "intervalMonths",
         "lastDoneAt", "manualDoneAt", "locationId", "source",
         "createdById", "updatedById", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), ${tenantId}::uuid, p."id", ${typeId}::uuid, rt."systemKey",
             ${months}::int,
             (${NOW}::timestamptz AT TIME ZONE 'America/Caracas')::date
               - ((p.n * 7919) % ceil(${months}::int * 30.44 / 0.8)::int),
             NULL,
             CASE WHEN p.n % 2 = 0 THEN ${sedes[0]}::uuid ELSE ${sedes[1]}::uuid END,
             'MANUAL', ${author}::uuid, ${author}::uuid, now(), now()
        FROM ${numbered}
        JOIN "recall_types" rt ON rt."id" = ${typeId}::uuid
       WHERE ${where}`;
  await recalls(types.HYGIENE, 6, Prisma.sql`p.n % 4 <> 0`);
  await recalls(types.PERIO, 3, Prisma.sql`p.n % 4 = 0`);
  await recalls(types.CHECKUP, 12, Prisma.sql`p.n % 2 = 0`);

  // Cada cita con su propio profesional (sin choques de la exclusión).
  await raw.$executeRaw`
    INSERT INTO "appointments"
      ("id", "tenantId", "locationId", "patientId", "providerId", "start", "end",
       "status", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${tenantId}::uuid,
           CASE WHEN (p.n + k) % 2 = 0 THEN ${sedes[0]}::uuid ELSE ${sedes[1]}::uuid END,
           p."id", gen_random_uuid(),
           ${NOW}::timestamp - make_interval(days => 30 + ((p.n * 31 + k * 97) % 700)),
           ${NOW}::timestamp - make_interval(days => 30 + ((p.n * 31 + k * 97) % 700)) + interval '30 minutes',
           'COMPLETED', now(), now()
      FROM ${numbered}, generate_series(1, 3) AS k`;
  await raw.$executeRaw`
    INSERT INTO "appointments"
      ("id", "tenantId", "locationId", "patientId", "providerId", "start", "end",
       "status", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${tenantId}::uuid, ${sedes[0]}::uuid, p."id", gen_random_uuid(),
           ${NOW}::timestamp + make_interval(days => 1 + p.n % 60),
           ${NOW}::timestamp + make_interval(days => 1 + p.n % 60) + interval '30 minutes',
           'SCHEDULED', now(), now()
      FROM ${numbered}
     WHERE p.n % 10 = 0`;
  return { tenantId, sedes };
}

/**
 * D17: `count` pacientes «Sin recall» sin ningún recall, con 2 citas
 * atendidas repartidas en 800 días (alguno queda fuera de los 24 meses) y, en
 * m % 10 = 0, una cita futura agendada.
 */
async function seedUnconfigured(clinic: Clinic, count: number): Promise<void> {
  const { tenantId, sedes } = clinic;
  await raw.$executeRaw`
    INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName", "phone", "updatedAt")
    SELECT gen_random_uuid(), ${tenantId}::uuid, 'Paciente', 'Sin recall ' || g,
           '+58 414 555 ' || lpad((g % 10000)::text, 4, '0'), now()
      FROM generate_series(1, ${count}::int) AS g`;
  const numbered = Prisma.sql`(
    SELECT "id", row_number() OVER (ORDER BY "id")::int AS m
      FROM "patients"
     WHERE "tenantId" = ${tenantId}::uuid AND "lastName" LIKE 'Sin recall %'
  ) p`;
  await raw.$executeRaw`
    INSERT INTO "appointments"
      ("id", "tenantId", "locationId", "patientId", "providerId", "start", "end",
       "status", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${tenantId}::uuid,
           CASE WHEN (p.m + k) % 2 = 0 THEN ${sedes[0]}::uuid ELSE ${sedes[1]}::uuid END,
           p."id", gen_random_uuid(),
           ${NOW}::timestamp - make_interval(days => 10 + ((p.m * 37 + k * 211) % 800)),
           ${NOW}::timestamp - make_interval(days => 10 + ((p.m * 37 + k * 211) % 800)) + interval '30 minutes',
           'COMPLETED', now(), now()
      FROM ${numbered}, generate_series(1, 2) AS k`;
  await raw.$executeRaw`
    INSERT INTO "appointments"
      ("id", "tenantId", "locationId", "patientId", "providerId", "start", "end",
       "status", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${tenantId}::uuid, ${sedes[1]}::uuid, p."id", gen_random_uuid(),
           ${NOW}::timestamp + make_interval(days => 1 + p.m % 60),
           ${NOW}::timestamp + make_interval(days => 1 + p.m % 60) + interval '30 minutes',
           'SCHEDULED', now(), now()
      FROM ${numbered}
     WHERE p.m % 10 = 0`;
}

/**
 * D17, consulta de referencia ingenua (owner, sin RLS): la última atendida
 * por paciente con una LATERAL, y las tres condiciones por paciente. Solo
 * para comprobar el total de `recallUnconfiguredSql`, no su plan.
 */
async function referenceUnconfiguredTotal(
  tenantId: string,
  locationId?: string,
): Promise<number> {
  const [row] = await raw.$queryRaw<{ total: number }[]>`
    SELECT count(*)::int AS total
      FROM "patients" p
      JOIN LATERAL (
        SELECT a."start", a."locationId"
          FROM "appointments" a
         WHERE a."tenantId" = p."tenantId" AND a."patientId" = p."id"
           AND a."status" = 'COMPLETED' AND a."deletedAt" IS NULL
         ORDER BY a."start" DESC, a."id" DESC
         LIMIT 1
      ) lc ON true
      JOIN "locations" l ON l."id" = lc."locationId"
     WHERE p."tenantId" = ${tenantId}::uuid
       AND p."deletedAt" IS NULL
       AND ((lc."start" AT TIME ZONE 'UTC') AT TIME ZONE l."timeZone")::date
             >= (((${NOW}::timestamptz) AT TIME ZONE l."timeZone")::date - interval '24 months')::date
       ${locationId ? Prisma.sql`AND l."id" = ${locationId}::uuid` : Prisma.empty}
       AND NOT EXISTS (
         SELECT 1 FROM "patient_recalls" pr
           JOIN "recall_types" rt ON rt."id" = pr."recallTypeId" AND rt."deletedAt" IS NULL
          WHERE pr."tenantId" = p."tenantId" AND pr."patientId" = p."id" AND pr."active")
       AND NOT EXISTS (
         SELECT 1 FROM "appointments" a
          WHERE a."tenantId" = p."tenantId" AND a."patientId" = p."id"
            AND a."deletedAt" IS NULL
            AND ((a."status" IN ('SCHEDULED', 'CONFIRMED') AND a."start" > ${NOW})
                 OR a."status" IN ('ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')))`;
  return row.total;
}

describe('DX-015-bis · lista de recall con 60.000 pacientes (int, rendimiento)', () => {
  let clinic: Clinic;
  const measured: string[] = [];

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    clinic = await seedClinic(SUBDOMAINS[0], PATIENTS);
    await seedUnconfigured(clinic, UNCONFIGURED);
    await seedClinic(SUBDOMAINS[1], NOISE_PATIENTS);
    for (const table of ['patients', 'patient_recalls', 'appointments']) {
      await raw.$executeRawUnsafe(`VACUUM ANALYZE "${table}"`);
    }
  }, 600_000);

  afterAll(async () => {
    console.log(
      `DX-015-bis · mediana de ${RUNS} tras ${WARMUP}:\n${measured.join('\n')}`,
    );
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await Promise.all([raw.$disconnect(), prisma.$disconnect()]);
  }, 300_000);

  const query = (
    over: Partial<RecallDueSqlParams> = {},
  ): RecallDueSqlParams => ({
    tenantId: clinic.tenantId,
    withinDays: 0,
    sort: 'MOST_OVERDUE',
    page: 1,
    pageSize: 25,
    now: NOW,
    ...over,
  });

  async function explain(
    sql: Prisma.Sql,
  ): Promise<{ nodes: PlanNode[]; ms: number }> {
    const rows = await prisma.runWithTenant(clinic.tenantId, (tx) =>
      tx.$queryRaw<
        { 'QUERY PLAN': { Plan: PlanNode; 'Execution Time': number }[] }[]
      >(Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`),
    );
    const [result] = rows[0]['QUERY PLAN'];
    return { nodes: flatten(result.Plan), ms: result['Execution Time'] };
  }

  /**
   * El plan sin Seq Scan (EXPLAIN sin ANALYZE): prueba que el índice sirve a
   * esta consulta. Aparte de la medición: aquí la clínica es ~85 % de
   * patient_recalls (solo 2 clínicas), y leer la tabla entera compite con el
   * índice; según el coste de cada corrida el planificador elige uno u otro
   * (los dos muy por debajo del presupuesto). Con muchas clínicas, como en
   * producción, el índice gana con margen.
   */
  async function indexPlan(sql: Prisma.Sql): Promise<PlanNode[]> {
    const rows = await prisma.runWithTenant(clinic.tenantId, async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
        Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`,
      );
    });
    return flatten(rows[0]['QUERY PLAN'][0].Plan);
  }

  /** Mediana de EXPLAIN ANALYZE tras el calentamiento, y el plan de la última. */
  async function measure(label: string, params: RecallDueSqlParams) {
    const times: number[] = [];
    let nodes: PlanNode[] = [];
    for (let i = 0; i < WARMUP + RUNS; i += 1) {
      const run = await explain(recallDueSql(params));
      if (i >= WARMUP) times.push(run.ms);
      nodes = run.nodes;
    }
    const ms = median(times);
    const line = `  ${label}: ${ms.toFixed(1)} ms (min ${Math.min(...times).toFixed(1)}, max ${Math.max(...times).toFixed(1)})`;
    measured.push(line);
    // También en el momento: el log de CI muestra cada mediana aunque falle.
    console.log(`DX-015-bis · mediana de ${RUNS} tras ${WARMUP}:${line}`);
    return { ms, nodes };
  }

  const recallScans = (nodes: PlanNode[]) =>
    nodes.filter((n) => n['Relation Name'] === 'patient_recalls');

  it('los datos son los del criterio: 90.000 recalls, ~20 % vencidos, ~10 % con cita futura', async () => {
    const [row] = await raw.$queryRaw<
      { recalls: number; due: number; upcoming: number }[]
    >`
      SELECT count(*)::int AS recalls,
             count(*) FILTER (WHERE pr."dueAt" <= (${NOW}::timestamptz AT TIME ZONE 'America/Caracas')::date)::int AS due,
             (SELECT count(DISTINCT a."patientId")::int FROM "appointments" a
               WHERE a."tenantId" = ${clinic.tenantId}::uuid AND a."status" = 'SCHEDULED') AS upcoming
        FROM "patient_recalls" pr
       WHERE pr."tenantId" = ${clinic.tenantId}::uuid`;
    expect(row.recalls).toBe(90_000);
    expect(row.due / row.recalls).toBeGreaterThan(0.17);
    expect(row.due / row.recalls).toBeLessThan(0.23);
    expect(row.upcoming).toBe(PATIENTS / 10 + UNCONFIGURED / 10);
  });

  it.each<[string, Partial<RecallDueSqlParams>]>([
    ['página 1, una sede', { locationIds: [] }],
    [
      'página 1, withinDays = 60, una sede',
      { withinDays: 60, locationIds: [] },
    ],
    ['página 1, vista consolidada', {}],
    ['due/count (consolidada, pageSize 1)', { pageSize: 1 }],
  ])(
    `%s: < ${BUDGET_MS} ms, una lectura de patient_recalls y por índice de la clínica`,
    async (label, over) => {
      const params = query({
        ...over,
        ...(over.locationIds ? { locationIds: [clinic.sedes[0]] } : {}),
      });
      const { ms, nodes } = await measure(label, params);
      // Una sola lectura de patient_recalls (por índice o entera).
      expect(recallScans(nodes)).toHaveLength(1);
      expect(ms).toBeLessThan(BUDGET_MS);
      // Sin Seq Scan, la lectura va por un índice de la clínica ("tenantId"
      // en cabeza): con muchas clínicas, como en producción, solo lee la suya.
      // No se exige cuál: el tope de "dueAt" llega de un InitPlan (maxToday) y
      // el planificador no conoce su valor, así que entre
      // patient_recalls_tenant_due_visit_idx y otro índice de la clínica elige
      // por coste de cada corrida (medido: los dos muy por debajo del tope).
      const indexed = await indexPlan(recallDueSql(params));
      expect(recallScans(indexed)).toHaveLength(1);
      const recallIndexes = indexed.filter((n) =>
        n['Index Name']?.startsWith('patient_recalls_'),
      );
      expect(recallIndexes.length).toBeGreaterThan(0);
      for (const n of recallIndexes) {
        expect(n['Index Cond']).toMatch(/^\(+"tenantId" = /);
      }
      console.log(
        `DX-015-bis · ${label}: índice sin Seq Scan = ${recallIndexes.map((n) => n['Index Name']).join(', ')}`,
      );
    },
    120_000,
  );

  it(`de punta a punta (repositorio, como la app): página 1 y recuento < ${BUDGET_MS} ms`, async () => {
    const wall = async (fn: () => Promise<unknown>) => {
      const times: number[] = [];
      for (let i = 0; i < WARMUP + RUNS; i += 1) {
        const t0 = performance.now();
        await fn();
        if (i >= WARMUP) times.push(performance.now() - t0);
      }
      return median(times);
    };
    const list = (pageSize: number, locationId?: string) =>
      tenantContext.run(clinic.tenantId, locationId, () =>
        repository.listDue({
          withinDays: 0,
          sort: 'MOST_OVERDUE',
          page: 1,
          pageSize,
          now: NOW,
        }),
      );
    const page = await list(25, clinic.sedes[0]);
    expect(page.rows).toHaveLength(25);
    expect(page.total).toBeGreaterThan(1_000);
    const pageMs = await wall(() => list(25, clinic.sedes[0]));
    const countMs = await wall(() => list(1));
    const lines = [
      `  listDue de punta a punta, página 1: ${pageMs.toFixed(1)} ms`,
      `  listDue de punta a punta, recuento: ${countMs.toFixed(1)} ms`,
    ];
    measured.push(...lines);
    console.log(
      `DX-015-bis · mediana de ${RUNS} tras ${WARMUP}:\n${lines.join('\n')}`,
    );
    expect(pageMs).toBeLessThan(BUDGET_MS);
    expect(countMs).toBeLessThan(BUDGET_MS);
  }, 120_000);

  // ------------------------------------------------------------------------
  // D17 · «Sin recall configurado»
  // ------------------------------------------------------------------------
  const unconfigured = (
    over: Partial<RecallUnconfiguredSqlParams> = {},
  ): RecallUnconfiguredSqlParams => ({
    tenantId: clinic.tenantId,
    page: 1,
    pageSize: 25,
    now: NOW,
    ...over,
  });

  /** Mediana de EXPLAIN ANALYZE tras el calentamiento. */
  async function measureSql(label: string, sql: Prisma.Sql) {
    const times: number[] = [];
    let nodes: PlanNode[] = [];
    for (let i = 0; i < WARMUP + RUNS; i += 1) {
      const run = await explain(sql);
      if (i >= WARMUP) times.push(run.ms);
      nodes = run.nodes;
    }
    const ms = median(times);
    const line = `  ${label}: ${ms.toFixed(1)} ms (min ${Math.min(...times).toFixed(1)}, max ${Math.max(...times).toFixed(1)})`;
    measured.push(line);
    console.log(`DX-015-bis · mediana de ${RUNS} tras ${WARMUP}:${line}`);
    return { ms, nodes };
  }

  const appointmentScans = (nodes: PlanNode[]) =>
    nodes.filter((n) => n['Relation Name'] === 'appointments');

  it('D17: el total coincide con la consulta de referencia (consolidada y por sede)', async () => {
    const run = (locationIds?: string[]) =>
      prisma.runWithTenant(clinic.tenantId, (tx) =>
        tx.$queryRaw<{ total: number }[]>(
          recallUnconfiguredSql(unconfigured({ pageSize: 1, locationIds })),
        ),
      );
    const all = await referenceUnconfiguredTotal(clinic.tenantId);
    // Los 6.000 menos los de cita futura y los que quedan fuera de 24 meses.
    expect(all).toBeGreaterThan(UNCONFIGURED * 0.8);
    expect(all).toBeLessThan(UNCONFIGURED * 0.9 + 1);
    expect((await run())[0].total).toBe(all);
    expect((await run([clinic.sedes[0]]))[0].total).toBe(
      await referenceUnconfiguredTotal(clinic.tenantId, clinic.sedes[0]),
    );
  }, 120_000);

  it.each<[string, Partial<RecallUnconfiguredSqlParams>]>([
    ['sin recall: página 1, una sede', { locationIds: [] }],
    ['sin recall: página 1, vista consolidada', {}],
    ['sin recall: recuento (consolidada, pageSize 1)', { pageSize: 1 }],
  ])(
    `%s: < ${BUDGET_MS} ms; citas por el índice de atendidas y recalls por índice`,
    async (label, over) => {
      const params = unconfigured({
        ...over,
        ...(over.locationIds ? { locationIds: [clinic.sedes[0]] } : {}),
      });
      const { ms } = await measureSql(label, recallUnconfiguredSql(params));
      expect(ms).toBeLessThan(BUDGET_MS);
      // Sin Seq Scan: la última atendida sale del índice parcial de
      // atendidas y el anti-join de recalls va por un índice de la clínica
      // ("tenantId" en cabeza, como la UNIQUE de paciente y tipo).
      const indexed = await indexPlan(recallUnconfiguredSql(params));
      expect(appointmentScans(indexed).map((n) => n['Index Name'])).toContain(
        'appointments_tenant_patient_completed_idx',
      );
      const recallIndexes = recallScans(indexed);
      expect(recallIndexes.length).toBeGreaterThan(0);
      for (const n of recallIndexes) {
        expect(n['Index Name']).toMatch(/^patient_recalls_/);
        expect(n['Index Cond']).toMatch(/^\(+"tenantId" = /);
      }
      console.log(
        `DX-015-bis · ${label}: índices sin Seq Scan = ${[
          ...appointmentScans(indexed),
          ...recallIndexes,
        ]
          .map((n) => n['Index Name'])
          .join(', ')}`,
      );
    },
    120_000,
  );

  it(`D17 de punta a punta (repositorio, como la app): página 1 y recuento < ${BUDGET_MS} ms`, async () => {
    const wall = async (fn: () => Promise<unknown>) => {
      const times: number[] = [];
      for (let i = 0; i < WARMUP + RUNS; i += 1) {
        const t0 = performance.now();
        await fn();
        if (i >= WARMUP) times.push(performance.now() - t0);
      }
      return median(times);
    };
    const list = (pageSize: number, locationId?: string) =>
      tenantContext.run(clinic.tenantId, locationId, () =>
        repository.listUnconfigured({ page: 1, pageSize, now: NOW }),
      );
    const page = await list(25, clinic.sedes[0]);
    expect(page.rows).toHaveLength(25);
    expect(page.total).toBeGreaterThan(1_000);
    // La última visita más reciente primero.
    const days = page.rows.map((r) => r.lastVisitAt);
    expect(days).toEqual([...days].sort().reverse());
    const pageMs = await wall(() => list(25, clinic.sedes[0]));
    const countMs = await wall(() => list(1));
    const lines = [
      `  listUnconfigured de punta a punta, página 1: ${pageMs.toFixed(1)} ms`,
      `  listUnconfigured de punta a punta, recuento: ${countMs.toFixed(1)} ms`,
    ];
    measured.push(...lines);
    console.log(
      `DX-015-bis · mediana de ${RUNS} tras ${WARMUP}:\n${lines.join('\n')}`,
    );
    expect(pageMs).toBeLessThan(BUDGET_MS);
    expect(countMs).toBeLessThan(BUDGET_MS);
  }, 120_000);

  // El ÚLTIMO de la suite: deja la clínica sin recalls (afterAll la purga).
  it(`D17, peor caso: la clínica sin ningún recall (~60.000 candidatos) < ${BUDGET_MS} ms`, async () => {
    // Una clínica que aún no usa el recall: sin ninguno. Con las estadísticas
    // y el mapa de visibilidad al día, como el resto de la suite.
    await raw.$executeRaw`
      DELETE FROM "patient_recalls" WHERE "tenantId" = ${clinic.tenantId}::uuid`;
    await raw.$executeRawUnsafe('VACUUM ANALYZE "patient_recalls"');
    const sql = recallUnconfiguredSql(unconfigured());
    const { ms } = await measureSql(
      'sin recall, peor caso (clínica sin recalls): página 1, consolidada',
      sql,
    );
    const [row] = await prisma.runWithTenant(clinic.tenantId, (tx) =>
      tx.$queryRaw<{ total: number }[]>(sql),
    );
    expect(row.total).toBeGreaterThan(PATIENTS * 0.8);
    expect(row.total).toBe(await referenceUnconfiguredTotal(clinic.tenantId));
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 300_000);
});
