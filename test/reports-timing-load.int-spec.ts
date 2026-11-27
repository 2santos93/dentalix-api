import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { civilPeriodByZone } from '../src/shared/time/civil-day';
import {
  TIMING_SESSION_SQL,
  bookedMinutesSql,
  timingGroupsSql,
  type TimingSqlParams,
} from '../src/modules/reports/infrastructure/prisma-timing.repository';
import {
  classifyTiming,
  percentileCont,
} from '../src/modules/reports/domain/timing';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';

// DX-275 · «Tiempos» con volumen: una clínica con 2 sedes en zonas distintas
// (Caracas y Kiritimati, UTC+14), 40 profesionales y 260.000 citas en ~2
// años (cada profesional, una cada 3 h; ~80 % completadas con sus horas,
// algunas sin ellas o incoherentes, ~10 % canceladas, ~5 % «No asistió»), y
// una segunda clínica de ruido. El informe de un año de toda la clínica
// recorre ~130.000 citas. VACUUM ANALYZE al final (lo que deja el autovacuum).
//
// La puerta NO es el tiempo (el mismo SHA mide el doble entre runners de la
// CI): son invariantes del plan, medidos con EXPLAIN ANALYZE como
// dentalix_app (runWithTenant, RLS, con el work_mem del informe): ningún Seq
// Scan de citas, las citas leídas una sola vez por (tenantId, locationId,
// start) —un rango por zona—, nada en disco (ni sorts ni hash en lotes ni
// bloques temporales). El tiempo se imprime y solo
// falla por encima de un techo de catástrofe. Las cifras del total se
// comprueban contra la referencia en TypeScript sobre las mismas filas.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = ['dx275-load', 'dx275-load-ruido'];
const APPOINTMENTS = 260_000;
const NOISE_APPOINTMENTS = 60_000;
const PROVIDERS = 40;
const PATIENTS = 20_000;
const ORIGIN = new Date('2025-01-06T12:00:00.000Z');
const PERIOD = { from: '2025-07-01', to: '2026-06-30' };
const CATASTROPHE_MS = 15_000;
const WARMUP = 1;
const RUNS = 3;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Loops'?: number;
  'Actual Rows'?: number;
  'Sort Space Type'?: string;
  'Hash Batches'?: number;
  'Temp Written Blocks'?: number;
  'Workers Launched'?: number;
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

/** La purga, con las citas de las clínicas de carga borradas sin disparadores. */
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
 * Cita s (0..n−1): profesional s % 40, a las ORIGEN + (s ÷ 40) · 3 h (sin
 * solapes en ninguna agenda ni de ningún paciente), 30 min, sede Kiritimati
 * si s % 3 = 0. Estado y horas por un hash de s: 10 % canceladas, 5 % «No
 * asistió»; de las completadas, ~3 % sin ninguna hora, ~2 % sin «Listo»,
 * ~1 % con 0 min en el sillón (incoherente) y el resto con espera, retraso y
 * duración variables.
 */
async function seedClinic(
  subdomain: string,
  appointments: number,
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
  const providers: string[] = [];
  for (let i = 0; i < PROVIDERS; i += 1) {
    const user = await raw.user.create({
      data: {
        email: `dx275-${i}-${tenantId}@example.com`,
        passwordHash: 'x',
        fullName: `Profesional ${String(i).padStart(2, '0')}`,
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: { tenantId, userId: user.id, role: 'DENTIST' },
    });
    providers.push(user.id);
    // Lunes a viernes: 08:00–12:00 en Chacao y 13:00–17:00 en Kiritimati (un
    // profesional no puede tener dos tramos solapados el mismo día).
    for (const [k, locationId] of sedes.entries()) {
      const schedule = await raw.providerSchedule.create({
        data: {
          tenantId,
          providerId: user.id,
          locationId,
          timezone: 'America/Caracas',
        },
        select: { id: true },
      });
      await raw.providerScheduleRange.createMany({
        data: [1, 2, 3, 4, 5].map((weekday) => ({
          tenantId,
          scheduleId: schedule.id,
          providerId: user.id,
          weekday,
          startMinute: k === 0 ? 480 : 780,
          endMinute: k === 0 ? 720 : 1020,
        })),
      });
    }
    // Dos semanas de vacaciones al año.
    await raw.scheduleBlock.create({
      data: {
        tenantId,
        providerId: user.id,
        start: new Date('2025-08-04T04:00:00.000Z'),
        end: new Date('2025-08-18T04:00:00.000Z'),
        kind: 'VACATION',
      },
    });
  }
  const types: string[] = [];
  for (const [name, minutes] of [
    ['Limpieza', 30],
    ['Control', 20],
    ['Endodoncia', 90],
    ['Extracción', 45],
    ['Ortodoncia', 30],
  ] as const) {
    const type = await raw.appointmentType.create({
      data: { tenantId, name, durationMinutes: minutes, color: '#0EA5E9' },
      select: { id: true },
    });
    types.push(type.id);
  }
  await raw.$executeRaw`
    INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName", "updatedAt")
    SELECT gen_random_uuid(), ${tenantId}::uuid, 'Paciente', 'Carga ' || g, now()
      FROM generate_series(1, ${PATIENTS}::int) AS g`;
  const patients = Prisma.sql`(
    SELECT "id", (row_number() OVER (ORDER BY "id") - 1)::int AS n
      FROM "patients" WHERE "tenantId" = ${tenantId}::uuid
  ) p`;
  await bulk(
    (tx) => tx.$executeRaw`
    INSERT INTO "appointments"
      ("id", "tenantId", "locationId", "patientId", "providerId", "appointmentTypeId",
       "start", "end", "status", "arrivedAt", "seatedAt", "readyForCheckoutAt",
       "cancelledAt", "cancelledByKind", "noticeMinutes", "lateCancellation",
       "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${tenantId}::uuid,
           CASE WHEN x.s % 3 = 0 THEN ${sedes[1]}::uuid ELSE ${sedes[0]}::uuid END,
           p."id", (${providers}::uuid[])[1 + x.s % ${PROVIDERS}::int],
           (${types}::uuid[])[1 + x.s % 6],
           x."start", x."start" + interval '30 minutes',
           x."status"::"AppointmentStatus",
           CASE WHEN x."status" = 'COMPLETED' AND x.h >= 3 THEN x."arrived" END,
           CASE WHEN x."status" = 'COMPLETED' AND x.h >= 3 THEN x."seated" END,
           CASE WHEN x."status" = 'COMPLETED' AND x.h >= 5 THEN
                CASE WHEN x.h = 5 THEN x."seated" ELSE x."seated" + make_interval(mins => 20 + (x.s * 19) % 40) END
           END,
           CASE WHEN x."status" = 'CANCELLED' THEN x."start" - interval '1 day' END,
           CASE WHEN x."status" = 'CANCELLED' THEN 'PATIENT_LINK'::"CancellationByKind" END,
           CASE WHEN x."status" = 'CANCELLED' THEN 1440 END,
           CASE WHEN x."status" = 'CANCELLED' THEN false END,
           now(), now()
      FROM (
        SELECT y.*, greatest(y."arrived", y."start") + make_interval(mins => (y.s * 17) % 30) AS "seated"
          FROM (
            SELECT g AS s, (g * 7) % 100 AS h,
                   ${ORIGIN}::timestamp + make_interval(hours => (g / ${PROVIDERS}::int) * 3) AS "start",
                   ${ORIGIN}::timestamp + make_interval(hours => (g / ${PROVIDERS}::int) * 3)
                     + make_interval(mins => (g * 13) % 41 - 20) AS "arrived",
                   CASE WHEN (g * 11) % 20 < 2 THEN 'CANCELLED'
                        WHEN (g * 11) % 20 = 2 THEN 'NO_SHOW'
                        ELSE 'COMPLETED' END AS "status"
              FROM generate_series(0, ${appointments}::int - 1) AS g
          ) y
      ) x
      JOIN ${patients} ON p.n = x.s % ${PATIENTS}::int`,
  );
  return { tenantId, sedes };
}

describe('DX-275 · «Tiempos» con 260.000 citas (int, rendimiento)', () => {
  let clinic: Clinic;
  let params: TimingSqlParams;
  const measured: string[] = [];

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purge();
    clinic = await seedClinic(SUBDOMAINS[0], APPOINTMENTS);
    await seedClinic(SUBDOMAINS[1], NOISE_APPOINTMENTS);
    for (const table of ['patients', 'appointments']) {
      await raw.$executeRawUnsafe(`VACUUM ANALYZE "${table}"`);
    }
    params = {
      tenantId: clinic.tenantId,
      branches: civilPeriodByZone(
        PERIOD.from,
        PERIOD.to,
        new Map([
          [clinic.sedes[0], 'America/Caracas'],
          [clinic.sedes[1], 'Pacific/Kiritimati'],
        ]),
      ),
    };
  }, 900_000);

  afterAll(async () => {
    console.log(
      `DX-275 · mediana de ${RUNS} tras ${WARMUP}:\n${measured.join('\n')}`,
    );
    await purge();
    await Promise.all([raw.$disconnect(), prisma.$disconnect()]);
  }, 600_000);

  // Como el repositorio: dentalix_app con la clínica fijada (RLS) y el
  // work_mem de la transacción del informe.
  const asApp = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.runWithTenant(
      clinic.tenantId,
      async (tx) => {
        await tx.$queryRaw(TIMING_SESSION_SQL);
        return fn(tx);
      },
      { timeout: 120_000 },
    );

  async function explain(sql: Prisma.Sql) {
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
    const line = `  ${label}: ${median(times).toFixed(1)} ms (min ${Math.min(...times).toFixed(1)}, max ${Math.max(...times).toFixed(1)})`;
    measured.push(line);
    // El plan resumido (nodo, índice, vueltas y filas), para leerlo en la CI
    // si un invariante falla.
    console.log(
      `DX-275 · plan de ${label}: ${nodes
        .map(
          (n) =>
            `${n['Node Type']}${n['Index Name'] ? `(${n['Index Name']})` : ''}×${n['Actual Loops'] ?? 1}:${n['Actual Rows'] ?? ''}`,
        )
        .join(' > ')}`,
    );
    console.log(`DX-275 ·${line}`);
    expect(median(times)).toBeLessThan(CATASTROPHE_MS);
    return nodes;
  }

  function expectPlanInvariants(
    nodes: PlanNode[],
    // Los índices de la clínica que empiezan por el tenant y acotan por el
    // inicio: cuál elige el planificador depende de las estadísticas del
    // runner (en local, el de la sede; en la CI llegó a elegir otro); lo
    // que se fija es que sea uno de ellos, una sola vez y sin disco.
    indexes: string[] = [
      'appointments_tenant_location_start_idx',
      'appointments_tenantId_providerId_start_idx',
      'appointments_tenant_start_live_idx',
    ],
  ) {
    // Nada en disco: ni sorts, ni hash en lotes, ni bloques temporales (los
    // sorts internos de percentile_cont también escribirían aquí).
    for (const n of nodes) {
      expect({
        node: n['Node Type'],
        space: n['Sort Space Type'] ?? 'Memory',
      }).toEqual({
        node: n['Node Type'],
        space: 'Memory',
      });
      expect(n['Hash Batches'] ?? 1).toBe(1);
      expect({
        node: n['Node Type'],
        temp: n['Temp Written Blocks'] ?? 0,
      }).toEqual({
        node: n['Node Type'],
        temp: 0,
      });
    }
    const appointments = nodes.filter(
      (n) => n['Relation Name'] === 'appointments',
    );
    expect(appointments.filter((n) => n['Node Type'] === 'Seq Scan')).toEqual(
      [],
    );
    // Las citas se leen UNA vez: un nodo sobre la tabla (en paralelo, una
    // vuelta por proceso: el líder y los workers del Gather) y, debajo, como
    // mucho un rango del índice por zona horaria (BitmapOr), cada uno una
    // sola vez (sin bucles por sede ni por fila).
    const workers = nodes
      .filter((n) => n['Node Type'].startsWith('Gather'))
      .reduce((sum, n) => sum + (n['Workers Launched'] ?? 0), 0);
    expect(appointments.length).toBe(1);
    expect(appointments[0]['Actual Loops']).toBeLessThanOrEqual(1 + workers);
    const byIndex = nodes.filter((n) =>
      indexes.includes(n['Index Name'] ?? ''),
    );
    expect({
      indexes: nodes.flatMap((n) => (n['Index Name'] ? [n['Index Name']] : [])),
      ok: byIndex.length > 0,
    }).toMatchObject({ ok: true });
    expect(byIndex.length).toBeLessThanOrEqual(params.branches.length);
    for (const n of byIndex) expect(n['Actual Loops']).toBe(1);
  }

  it('los datos son los del criterio: 260.000 citas, ~130.000 en el año del informe', async () => {
    const [counts] = await raw.$queryRaw<{ total: number; inPeriod: number }[]>`
      SELECT count(*)::int AS "total",
             count(*) FILTER (WHERE "start" >= '2025-07-01' AND "start" < '2026-07-01')::int AS "inPeriod"
        FROM "appointments" WHERE "tenantId" = ${clinic.tenantId}::uuid`;
    expect(counts.total).toBe(APPOINTMENTS);
    expect(counts.inPeriod).toBeGreaterThan(110_000);
    console.log(
      `DX-275 · clínica: ${counts.total} citas, ${counts.inPeriod} en el período`,
    );
  });

  it('el total coincide con la referencia en TypeScript (clasificación, medias y p90)', async () => {
    const groups = await asApp((tx) =>
      tx.$queryRaw<
        {
          grouping: number;
          completed: number;
          measured: number;
          withoutTimes: number;
          incoherent: number;
          waitAvg: number;
          waitP90: number;
          startDelayP90: number;
          durationAvg: number;
          durationP90: number;
        }[]
      >(timingGroupsSql(params)),
    );
    const total = groups.find((g) => g.grouping === 7)!;
    const rows = await raw.$queryRaw<
      {
        start: Date;
        end: Date;
        arrivedAt: Date | null;
        seatedAt: Date | null;
        readyForCheckoutAt: Date | null;
      }[]
    >`
      SELECT a."start", a."end", a."arrivedAt", a."seatedAt", a."readyForCheckoutAt"
        FROM "appointments" a
        JOIN "locations" lo ON lo."id" = a."locationId"
       WHERE a."tenantId" = ${clinic.tenantId}::uuid
         AND a."deletedAt" IS NULL AND a."status" = 'COMPLETED'
         AND timezone(lo."timeZone", a."start" AT TIME ZONE 'UTC')::date
             BETWEEN ${PERIOD.from}::date AND ${PERIOD.to}::date`;
    const samples = rows.map((r) => classifyTiming(r));
    const ok = samples.filter((x) => x.kind === 'MEASURED');
    expect(total.completed).toBe(samples.length);
    expect(total.measured).toBe(ok.length);
    expect(total.withoutTimes).toBe(
      samples.filter((x) => x.kind === 'WITHOUT_TIMES').length,
    );
    expect(total.incoherent).toBe(
      samples.filter((x) => x.kind === 'INCOHERENT').length,
    );
    expect(total.withoutTimes).toBeGreaterThan(1000);
    expect(total.incoherent).toBeGreaterThan(500);
    const waits = ok.map((x) => x.waitMinutes as number);
    expect(total.waitAvg).toBeCloseTo(
      waits.reduce((a, b) => a + b, 0) / waits.length,
      6,
    );
    expect(total.waitP90).toBeCloseTo(percentileCont(waits, 0.9)!, 6);
    expect(total.startDelayP90).toBeCloseTo(
      percentileCont(
        ok.map((x) => x.startDelayMinutes as number),
        0.9,
      )!,
      6,
    );
    expect(total.durationP90).toBeCloseTo(
      percentileCont(
        ok.map((x) => x.durationMinutes as number),
        0.9,
      )!,
      6,
    );
    console.log(
      `DX-275 · total: ${total.completed} atendidas, ${total.measured} medidas, ${total.withoutTimes} sin tiempos, ${total.incoherent} incoherentes; espera media ${total.waitAvg.toFixed(1)}, p90 ${total.waitP90.toFixed(1)}`,
    );
  }, 300_000);

  it('tiempos de toda la clínica (un año): sin Seq Scan de citas, las citas una sola vez por el índice, nada en disco', async () => {
    expectPlanInvariants(
      await measure('tiempos (toda la clínica)', timingGroupsSql(params)),
    );
  }, 300_000);

  it('agenda por profesional y semana (un año): mismos invariantes', async () => {
    expectPlanInvariants(
      await measure('agenda (toda la clínica)', bookedMinutesSql(params)),
    );
  }, 300_000);

  it('tiempos de un profesional en una sede: mismos invariantes', async () => {
    const [providerId] = await raw.$queryRaw<{ id: string }[]>`
      SELECT "userId" AS "id" FROM "clinic_memberships"
       WHERE "tenantId" = ${clinic.tenantId}::uuid ORDER BY "userId" LIMIT 1`;
    expectPlanInvariants(
      await measure(
        'tiempos (un profesional)',
        timingGroupsSql({
          ...params,
          branches: params.branches.filter((b) =>
            b.locationIds.includes(clinic.sedes[0]),
          ),
          providerId: providerId.id,
        }),
      ),
    );
  }, 300_000);
});
