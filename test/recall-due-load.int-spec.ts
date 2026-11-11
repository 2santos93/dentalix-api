import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  PrismaRecallRepository,
  recallDueSql,
  type RecallDueSqlParams,
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
// y el plan recorre `patient_recalls_tenant_due_idx`. `raw` (DIRECT_URL,
// owner) siembra y limpia. Sin "patientCode" en los INSERT: lo pone el
// trigger (DX-484). Las cifras medidas se imprimen (informe de DX-015-bis).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repository = new PrismaRecallRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx015bis-load', 'dx015bis-load-ruido'];
const PATIENTS = 60_000;
const NOISE_PATIENTS = 10_000;
const BUDGET_MS = 500;
const DUE_INDEX = 'patient_recalls_tenant_due_idx';
const NOW = new Date('2027-04-10T15:00:00.000Z');
const WARMUP = 2;
const RUNS = 7;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
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

describe('DX-015-bis · lista de recall con 60.000 pacientes (int, rendimiento)', () => {
  let clinic: Clinic;
  const measured: string[] = [];

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    clinic = await seedClinic(SUBDOMAINS[0], PATIENTS);
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
    measured.push(
      `  ${label}: ${ms.toFixed(1)} ms (min ${Math.min(...times).toFixed(1)}, max ${Math.max(...times).toFixed(1)})`,
    );
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
    expect(row.upcoming).toBe(PATIENTS / 10);
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
    `%s: < ${BUDGET_MS} ms y por patient_recalls_tenant_due_idx`,
    async (label, over) => {
      const params = query({
        ...over,
        ...(over.locationIds ? { locationIds: [clinic.sedes[0]] } : {}),
      });
      const { ms, nodes } = await measure(label, params);
      const scans = recallScans(nodes);
      expect(scans).toHaveLength(1);
      expect(nodes.map((n) => n['Index Name'])).toContain(DUE_INDEX);
      expect(ms).toBeLessThan(BUDGET_MS);
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
    measured.push(
      `  listDue de punta a punta, página 1: ${pageMs.toFixed(1)} ms`,
      `  listDue de punta a punta, recuento: ${countMs.toFixed(1)} ms`,
    );
    expect(pageMs).toBeLessThan(BUDGET_MS);
    expect(countMs).toBeLessThan(BUDGET_MS);
  }, 120_000);
});
