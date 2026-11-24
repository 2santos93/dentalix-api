import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  PrismaRetentionRepository,
  retentionGroupsSql,
  retentionPatientsSql,
  type RetentionSqlParams,
} from '../src/modules/reports/infrastructure/prisma-retention.repository';
import {
  addFacts,
  EMPTY_RETENTION_COUNTS,
  retentionBounds,
  withRate,
  type RetentionFacts,
} from '../src/modules/reports/domain/retention';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';

// DX-260 (criterio: < 1 s con 60.000 pacientes y 500.000 citas). Una clínica
// con 60.000 pacientes, 2 sedes en zonas distintas (Caracas y Kiritimati,
// UTC+14), 40 profesionales y ~510.000 citas en casi 3 años (cada paciente
// con 1–16 visitas cada ~2 meses; ~15 % canceladas o «No asistió»), ~10 % con
// una cita futura agendada, y una segunda clínica de ruido. VACUUM ANALYZE al
// final (lo que deja el autovacuum: estadísticas y mapa de visibilidad).
//
// La puerta NO es el tiempo (el mismo SHA mide el doble entre runners de la
// CI): son invariantes del plan, medidos con EXPLAIN ANALYZE como
// dentalix_app (runWithTenant, RLS): la pasada por las atendidas es SOLO de
// índice (appointments_tenant_patient_completed_provider_idx) y sin ordenar,
// ningún Seq Scan de citas, nada en disco, y las sondas de cita futura y de
// vuelta en 90 días acotadas a quien las necesita. El tiempo se imprime y
// solo falla por encima de un techo de catástrofe (10×). Las cifras se
// comprueban contra una consulta de referencia ingenua.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repository = new PrismaRetentionRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx260-load', 'dx260-load-ruido'];
const PATIENTS = 60_000;
const NOISE_PATIENTS = 10_000;
const VISITS = 16;
const PROVIDERS = 40;
const NOW = new Date('2026-07-15T15:00:00.000Z');
const PERIOD = { from: '2026-01-01', to: '2026-06-30' };
const BUDGET_MS = 1000;
const CATASTROPHE_MS = BUDGET_MS * 10;
const WARMUP = 2;
const RUNS = 5;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Loops'?: number;
  'Actual Rows'?: number;
  'Heap Fetches'?: number;
  'Sort Space Type'?: string;
  'Hash Batches'?: number;
  Plans?: PlanNode[];
}
const flatten = (plan: PlanNode): PlanNode[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(flatten),
];
const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Una carga masiva sin disparadores, en su transacción (sin el tope de 5 s). */
function bulk(
  fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<unknown> {
  return raw.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        'SET LOCAL session_replication_role = replica',
      );
      return fn(tx);
    },
    { timeout: 600_000, maxWait: 60_000 },
  );
}

/**
 * La purga, con las citas de las clínicas de carga borradas antes sin
 * disparadores (sus FKs en cascada no tienen hijos aquí): borrar ~600k
 * citas fila a fila con disparadores tarda minutos.
 */
async function purge(): Promise<void> {
  await bulk(
    (tx) => tx.$executeRaw`
      DELETE FROM "appointments" a
       USING "tenants" t
       WHERE t."id" = a."tenantId" AND t."subdomain" = ANY(${SUBDOMAINS})`,
  );
  await purgeTenantsBySubdomain(raw, SUBDOMAINS);
}

interface Clinic {
  tenantId: string;
  sedes: [string, string];
}

/**
 * Cita k (1..16) del paciente n: hueco `(k − 1)·pacientes + n` repartido
 * entre 40 profesionales cada 60 minutos (sin solapes en ninguna agenda), así
 * que las visitas de un paciente quedan a ~2 meses. El paciente n solo tiene
 * `1 + n % 16` visitas; estado por un hash: 10 % canceladas, 5 % «No asistió».
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
  const providers = Array.from(
    { length: PROVIDERS },
    (_, i) => `00000000-0000-4000-8260-${String(i).padStart(12, '0')}`,
  );
  await raw.$executeRaw`
    INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName", "phone", "updatedAt")
    SELECT gen_random_uuid(), ${tenantId}::uuid, 'Paciente', 'Carga ' || g,
           '+58 412 555 ' || lpad((g % 10000)::text, 4, '0'), now()
      FROM generate_series(1, ${patients}::int) AS g`;
  const numbered = Prisma.sql`(
    SELECT "id", row_number() OVER (ORDER BY "id")::int AS n
      FROM "patients" WHERE "tenantId" = ${tenantId}::uuid
  ) p`;
  const origin = new Date(NOW.getTime() - 1005 * 86_400_000);
  // Las citas, sin los disparadores (session_replication_role = replica):
  // ~500k filas con sus FKs y la «última atención» de DX-039 tardan
  // minutos y aquí no se leen. La exclusión de solapes sí se comprueba.
  await bulk(
    (tx) => tx.$executeRaw`
    INSERT INTO "appointments"
      ("id", "tenantId", "locationId", "patientId", "providerId", "start", "end",
       "status", "cancelledAt", "cancelledByKind", "noticeMinutes", "lateCancellation",
       "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${tenantId}::uuid,
           CASE WHEN (x.n + x.k) % 3 = 0 THEN ${sedes[1]}::uuid ELSE ${sedes[0]}::uuid END,
           x."id", (${providers}::uuid[])[1 + x.slot % ${PROVIDERS}::int],
           x."start", x."start" + interval '30 minutes',
           x."status"::"AppointmentStatus",
           CASE WHEN x."status" = 'CANCELLED' THEN x."start" - interval '1 day' END,
           CASE WHEN x."status" = 'CANCELLED' THEN 'PATIENT_LINK'::"CancellationByKind" END,
           CASE WHEN x."status" = 'CANCELLED' THEN 1440 END,
           CASE WHEN x."status" = 'CANCELLED' THEN false END,
           now(), now()
      FROM (
        SELECT p."id", p.n, k, (k - 1) * ${patients}::int + p.n AS slot,
               ${origin}::timestamp
                 + make_interval(mins => (((k - 1) * ${patients}::int + p.n) / ${PROVIDERS}::int) * 60) AS "start",
               CASE WHEN (p.n * 7 + k * 13) % 20 < 2 THEN 'CANCELLED'
                    WHEN (p.n * 7 + k * 13) % 20 = 2 THEN 'NO_SHOW'
                    ELSE 'COMPLETED' END AS "status"
          FROM ${numbered}, generate_series(1, ${VISITS}::int) AS k
         WHERE k <= 1 + p.n % ${VISITS}::int
      ) x`,
  );
  // ~10 %: una cita futura agendada (un profesional aparte por cita).
  await bulk(
    (tx) => tx.$executeRaw`
    INSERT INTO "appointments"
      ("id", "tenantId", "locationId", "patientId", "providerId", "start", "end",
       "status", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${tenantId}::uuid, ${sedes[0]}::uuid, p."id", gen_random_uuid(),
           ${NOW}::timestamp + make_interval(days => 1 + p.n % 60),
           ${NOW}::timestamp + make_interval(days => 1 + p.n % 60) + interval '30 minutes',
           'SCHEDULED', now(), now()
      FROM ${numbered}
     WHERE p.n % 10 = 0`,
  );
  return { tenantId, sedes };
}

/**
 * Referencia ingenua (owner, sin RLS, un paciente cada vez con LATERAL):
 * activos al inicio y perdidos, con los cortes de cada sede.
 */
async function reference(
  clinic: Clinic,
  bounds: RetentionSqlParams['bounds'],
): Promise<{ activeAtStart: number; lost: number }> {
  const b = (pick: (x: (typeof bounds)[number]) => Date) =>
    Prisma.sql`${bounds.map((x) => pick(x).toISOString().replace('T', ' ').replace('Z', ''))}::timestamp[]`;
  const [row] = await raw.$queryRaw<{ activeAtStart: number; lost: number }[]>`
    WITH b AS (
      SELECT * FROM unnest(${bounds.map((x) => x.locationId)}::uuid[],
                           ${b((x) => x.periodStart)}, ${b((x) => x.periodEnd)},
                           ${b((x) => x.startCutoff)}, ${b((x) => x.endCutoff)})
        AS b("id", "startAt", "endAt", "startCut", "endCut")
    ),
    per AS (
      SELECT pa."id",
             EXISTS (SELECT 1 FROM "appointments" a JOIN b ON b."id" = a."locationId"
                      WHERE a."tenantId" = pa."tenantId" AND a."patientId" = pa."id"
                        AND a."status" = 'COMPLETED' AND a."deletedAt" IS NULL
                        AND a."start" >= b."startCut" AND a."start" < b."startAt") AS "start",
             EXISTS (SELECT 1 FROM "appointments" a JOIN b ON b."id" = a."locationId"
                      WHERE a."tenantId" = pa."tenantId" AND a."patientId" = pa."id"
                        AND a."status" = 'COMPLETED' AND a."deletedAt" IS NULL
                        AND a."start" >= b."endCut" AND a."start" < b."endAt") AS "end",
             EXISTS (SELECT 1 FROM "appointments" a
                      WHERE a."tenantId" = pa."tenantId" AND a."patientId" = pa."id"
                        AND a."deletedAt" IS NULL
                        AND ((a."status" IN ('SCHEDULED', 'CONFIRMED') AND a."start" > ${NOW})
                             OR a."status" IN ('ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT'))) AS "upcoming"
        FROM "patients" pa
       WHERE pa."tenantId" = ${clinic.tenantId}::uuid AND pa."deletedAt" IS NULL
    )
    SELECT count(*) FILTER (WHERE "start")::int AS "activeAtStart",
           count(*) FILTER (WHERE "start" AND NOT "end" AND NOT "upcoming")::int AS "lost"
      FROM per`;
  return row;
}

describe('DX-260 · «Retención» con 60.000 pacientes y 500.000 citas (int, rendimiento)', () => {
  let clinic: Clinic;
  let params: RetentionSqlParams;
  const measured: string[] = [];

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purge();
    clinic = await seedClinic(SUBDOMAINS[0], PATIENTS);
    await seedClinic(SUBDOMAINS[1], NOISE_PATIENTS);
    for (const table of ['patients', 'appointments']) {
      await raw.$executeRawUnsafe(`VACUUM ANALYZE "${table}"`);
    }
    const zones = await tenantContext.run(clinic.tenantId, () =>
      repository.locationZones(),
    );
    params = {
      tenantId: clinic.tenantId,
      bounds: [...zones].map(([locationId, zone]) => ({
        locationId,
        ...retentionBounds(PERIOD, 18, zone),
      })),
      locationIds: clinic.sedes,
      now: NOW,
    };
  }, 900_000);

  afterAll(async () => {
    console.log(
      `DX-260 · mediana de ${RUNS} tras ${WARMUP}:\n${measured.join('\n')}`,
    );
    await purge();
    await Promise.all([raw.$disconnect(), prisma.$disconnect()]);
  }, 600_000);

  // Como dentalix_app con la clínica fijada (RLS). Sin el tope de 5 s de la
  // transacción: en un runner cargado la primera corrida (en frío) lo pasa;
  // el tiempo lo vigila `measure`, no el tope.
  const asApp = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.runWithTenant(clinic.tenantId, fn, { timeout: 120_000 });

  async function explain(sql: Prisma.Sql) {
    // TIMING OFF (DX-558-bis): sin el reloj por nodo y fila, que con ~500k
    // filas infla el tiempo; los recuentos de filas y vueltas siguen.
    const rows = await asApp((tx) =>
      tx.$queryRaw<
        { 'QUERY PLAN': { Plan: PlanNode; 'Execution Time': number }[] }[]
      >(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${sql}`),
    );
    const [plan] = rows[0]['QUERY PLAN'];
    return { ms: plan['Execution Time'], nodes: flatten(plan.Plan) };
  }

  async function measure(label: string, sql: Prisma.Sql) {
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
    console.log(`DX-260 · mediana de ${RUNS} tras ${WARMUP}:${line}`);
    if (ms >= BUDGET_MS) {
      console.warn(
        `DX-260 · ${label}: por encima del criterio de ${BUDGET_MS} ms (runner lento o plan peor)`,
      );
    }
    expect(ms).toBeLessThan(CATASTROPHE_MS);
    return nodes;
  }

  function expectPlanInvariants(nodes: PlanNode[]) {
    // Nada en disco: work_mem bastó.
    for (const n of nodes) {
      expect(n['Sort Space Type'] ?? 'Memory').not.toBe('Disk');
      expect(n['Hash Batches'] ?? 1).toBe(1);
    }
    const appointments = nodes.filter(
      (n) => n['Relation Name'] === 'appointments',
    );
    // Ningún Seq Scan de citas: todo por índices de la clínica.
    expect(appointments.filter((n) => n['Node Type'] === 'Seq Scan')).toEqual(
      [],
    );
    // La pasada principal: una sola vez, SOLO índice, con el mapa de
    // visibilidad al día (casi sin ir a la tabla).
    const main = appointments.filter(
      (n) =>
        n['Index Name'] ===
        'appointments_tenant_patient_completed_provider_idx',
    );
    expect(main.map((n) => n['Node Type'])).toContain('Index Only Scan');
    const pass = main.find((n) => n['Node Type'] === 'Index Only Scan')!;
    expect(pass['Actual Loops']).toBe(1);
    expect(pass['Heap Fetches'] ?? 0).toBeLessThan(1000);
    // Sin Sort sobre las citas: el GROUP BY y el array_agg ordenado leen el
    // orden del índice (el único Sort permitido es el de la página).
    const sorts = nodes.filter((n) => n['Node Type'] === 'Sort');
    for (const s of sorts) {
      expect(s['Actual Rows'] ?? 0).toBeLessThan(PATIENTS);
    }
    // Las sondas por paciente (cita futura, vuelta en 90 días) solo para
    // quien puede perderse o es nuevo: nunca una por cada paciente.
    for (const n of appointments.filter((x) => x !== pass)) {
      expect(n['Actual Loops'] ?? 1).toBeLessThan(PATIENTS / 2);
    }
  }

  it('los datos son los del criterio: 60.000 pacientes y más de 500.000 citas', async () => {
    const [counts] = await raw.$queryRaw<
      { patients: number; appointments: number }[]
    >`SELECT (SELECT count(*)::int FROM "patients" WHERE "tenantId" = ${clinic.tenantId}::uuid) AS "patients",
             (SELECT count(*)::int FROM "appointments" WHERE "tenantId" = ${clinic.tenantId}::uuid) AS "appointments"`;
    expect(counts.patients).toBe(PATIENTS);
    expect(counts.appointments).toBeGreaterThan(500_000);
    console.log(
      `DX-260 · clínica: ${counts.patients} pacientes, ${counts.appointments} citas (más la de ruido)`,
    );
  });

  it('las cifras coinciden con la consulta de referencia y cada lista con su cifra', async () => {
    const groups = await asApp((tx) =>
      tx.$queryRaw<(RetentionFacts & { count: number })[]>(
        retentionGroupsSql(params),
      ),
    );
    const totals = { ...EMPTY_RETENTION_COUNTS };
    for (const g of groups) addFacts(totals, g, Number(g.count));
    const ref = await reference(clinic, params.bounds);
    expect(totals.activeAtStart).toBe(ref.activeAtStart);
    expect(totals.lost).toBe(ref.lost);
    expect(totals.activeAtStart).toBeGreaterThan(1000);
    expect(totals.lost).toBeGreaterThan(100);
    const [lost] = await asApp((tx) =>
      tx.$queryRaw<{ total: number }[]>(
        retentionPatientsSql({ ...params, segment: 'lost', skip: 0, take: 1 }),
      ),
    );
    expect(lost.total).toBe(totals.lost);
    console.log(`DX-260 · cifras: ${JSON.stringify(withRate(totals))}`);
  }, 300_000);

  it('el informe: solo índice, sin Seq Scan de citas, sin disco ni sondas por paciente', async () => {
    expectPlanInvariants(
      await measure('informe (toda la clínica)', retentionGroupsSql(params)),
    );
  }, 300_000);

  it('la lista de perdidos, página 1: mismos invariantes', async () => {
    expectPlanInvariants(
      await measure(
        'lista de perdidos (página 1)',
        retentionPatientsSql({ ...params, segment: 'lost', skip: 0, take: 25 }),
      ),
    );
  }, 300_000);

  it('la lista de activos al final con una sede: mismos invariantes', async () => {
    expectPlanInvariants(
      await measure(
        'lista de activos al final (una sede)',
        retentionPatientsSql({
          ...params,
          locationIds: [clinic.sedes[0]],
          segment: 'active_end',
          skip: 0,
          take: 25,
        }),
      ),
    );
  }, 300_000);
});
