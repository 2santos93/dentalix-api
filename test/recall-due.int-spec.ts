import { randomUUID } from 'node:crypto';
import {
  AppointmentStatus,
  Prisma,
  PrismaClient,
  RecallContactChannel,
  RecallContactOutcome,
  RecallKind,
} from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  PrismaRecallRepository,
  recallDueSql,
} from '../src/modules/recall/infrastructure/prisma-recall.repository';
import type {
  RecallDueQuery,
  RecallDueRow,
  RecallDueSort,
} from '../src/modules/recall/domain/recall.entity';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';
import { referenceListDue } from './support/recall-due-reference';

// DX-547 (DB-079), capa BD: la lista de recall con el repositorio Prisma REAL
// como `dentalix_app` (DATABASE_URL, RLS FORCE). `raw` (owner, DIRECT_URL)
// solo siembra y limpia. Compara la consulta nueva (una sola sentencia, filtros
// antes de las LATERAL, índice de citas vivas del paciente) con el ORÁCULO
// `referenceListDue` (la consulta de DX-015 tal cual) sobre datos que cubren
// vencido / no vencido, con y sin cita futura, cita en clínica, varias sedes
// en zonas extremas (UTC+14 y UTC−11, el «hoy» cambia de día entre sedes),
// pacientes sin cita atendida (base = lastDoneAt), pausados, inactivos,
// archivados y dos clínicas.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repository = new PrismaRecallRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx547-int-a', 'dx547-int-b'];
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** 11:30 UTC: ya es mañana en Kiritimati (UTC+14); 00:30 en Pago Pago. */
const NOW = new Date('2026-11-06T11:30:00.000Z');
/** 09:00 UTC: todavía es ayer en Pago Pago (UTC−11). */
const EARLIER = new Date('2026-11-06T09:00:00.000Z');
/** Fin de febrero: recorte a fin de mes en el vencimiento. */
const LATER = new Date('2027-02-28T23:30:00.000Z');
const NOWS = [NOW, EARLIER, LATER];
const ZONES = ['Pacific/Kiritimati', 'America/Caracas', 'Pacific/Pago_Pago'];
const civil = (d: Date) => d.toISOString().slice(0, 10);
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);

/** PRNG con semilla: los mismos datos en cada corrida. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Clinic {
  tenantId: string;
  sedes: string[];
  authorId: string;
  recallIds: Set<string>;
}

const FIRST = ['Ana', 'Luis', 'María', 'José', 'Ángela'];
const LAST = ['Pérez', 'Gómez', 'Álvarez', 'Díaz', 'Núñez', 'de la Rosa'];
const INTERVALS = [1, 3, 6, 6, 6, 12, 24, 36];
const END_OF_MONTH = ['2026-05-31', '2024-02-29', '2025-08-31', '2026-08-31'];

async function seedClinic(
  subdomain: string,
  patients: number,
  seed: number,
): Promise<Clinic> {
  const rnd = mulberry32(seed);
  const int = (min: number, max: number) =>
    min + Math.floor(rnd() * (max - min + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];

  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const sedes: string[] = [];
  for (const [i, timeZone] of ZONES.entries()) {
    const loc = await raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId: tenant.id,
        name: `Sede ${i + 1}`,
        timeZone,
        defaultPhoneRegion: i === 0 ? 'KI' : 'VE',
      }),
    });
    sedes.push(loc.id);
  }
  const author = await raw.user.create({
    data: {
      email: `recepcion@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Recepción',
    },
  });

  const patientRows: Prisma.PatientCreateManyInput[] = [];
  const recallRows: Prisma.PatientRecallCreateManyInput[] = [];
  const appointmentRows: Prisma.AppointmentCreateManyInput[] = [];
  const contactRows: Prisma.RecallContactCreateManyInput[] = [];

  for (let i = 0; i < patients; i += 1) {
    const patientId = randomUUID();
    patientRows.push({
      id: patientId,
      tenantId: tenant.id,
      firstName: pick(FIRST),
      lastName: pick(LAST),
      phone: rnd() < 0.8 ? `+58 412 555 ${String(i).padStart(4, '0')}` : null,
      ...(rnd() < 0.15
        ? {
            reminderOptOutAt: new Date('2026-01-01T00:00:00Z'),
            reminderOptOutSource: 'STAFF' as const,
          }
        : {}),
      deletedAt: rnd() < 0.08 ? new Date('2026-06-01T00:00:00Z') : null,
    });

    for (const kind of [RecallKind.HYGIENE, RecallKind.CHECKUP]) {
      if (rnd() >= 0.65) continue;
      const lastDoneAt =
        rnd() < 0.1
          ? DAY(pick(END_OF_MONTH))
          : new Date(NOW.getTime() - int(-20, 1_200) * DAY_MS);
      const paused = rnd() < 0.2;
      const id = randomUUID();
      recallRows.push({
        id,
        tenantId: tenant.id,
        patientId,
        kind,
        intervalMonths: pick(INTERVALS),
        lastDoneAt: DAY(civil(lastDoneAt)),
        locationId: pick(sedes),
        active: rnd() < 0.88,
        disabledUntil: paused
          ? DAY(civil(new Date(NOW.getTime() + int(-3, 120) * DAY_MS)))
          : null,
        disabledReason: paused ? 'Tratamiento en curso' : null,
        createdById: author.id,
        updatedById: author.id,
      });
      const contacts = rnd() < 0.3 ? int(1, 2) : 0;
      for (let c = 0; c < contacts; c += 1) {
        contactRows.push({
          id: randomUUID(),
          tenantId: tenant.id,
          recallId: id,
          patientId,
          locationId: pick(sedes),
          channel: pick(Object.values(RecallContactChannel)),
          outcome: pick(
            Object.values(RecallContactOutcome).filter(
              (o) => o !== RecallContactOutcome.BOOKED,
            ),
          ),
          authorId: author.id,
        });
      }
    }

    // Citas del paciente: un día distinto cada una (no se solapan).
    const providerId = randomUUID();
    const usedDays = new Set<number>();
    const appointments = int(0, 5);
    for (let k = 0; k < appointments; k += 1) {
      const r = rnd();
      let status: AppointmentStatus;
      let day: number;
      let hourUtc = int(0, 23);
      let deleted = false;
      if (r < 0.4) {
        status = AppointmentStatus.COMPLETED;
        day = -int(1, 1_100);
        deleted = rnd() < 0.08;
      } else if (r < 0.55) {
        status = pick([
          AppointmentStatus.SCHEDULED,
          AppointmentStatus.CONFIRMED,
        ]);
        day = int(1, 90);
        deleted = rnd() < 0.15;
      } else if (r < 0.62) {
        // Entre EARLIER (09:00Z) y NOW (11:30Z): futura para una, pasada para la otra.
        status = AppointmentStatus.SCHEDULED;
        day = 0;
        hourUtc = 10;
      } else if (r < 0.7) {
        // Agendada en el pasado y nunca cerrada: no es «cita futura».
        status = pick([
          AppointmentStatus.SCHEDULED,
          AppointmentStatus.CONFIRMED,
        ]);
        day = -int(1, 400);
      } else if (r < 0.8) {
        status = pick([AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW]);
        day = r < 0.75 ? int(1, 60) : -int(1, 300);
      } else if (r < 0.88) {
        status = pick([
          AppointmentStatus.ARRIVED,
          AppointmentStatus.IN_CHAIR,
          AppointmentStatus.READY_FOR_CHECKOUT,
        ]);
        day = -int(0, 2);
        deleted = rnd() < 0.2;
      } else {
        status = AppointmentStatus.COMPLETED;
        day = int(1, 5) * -1;
        hourUtc = pick([0, 1, 10, 13, 23]);
      }
      if (usedDays.has(day)) continue;
      usedDays.add(day);
      const start = new Date(
        DAY(civil(NOW)).getTime() + day * DAY_MS + hourUtc * HOUR_MS,
      );
      const inClinic =
        status === AppointmentStatus.ARRIVED ||
        status === AppointmentStatus.IN_CHAIR ||
        status === AppointmentStatus.READY_FOR_CHECKOUT;
      const seated =
        status === AppointmentStatus.IN_CHAIR ||
        status === AppointmentStatus.READY_FOR_CHECKOUT;
      appointmentRows.push({
        id: randomUUID(),
        tenantId: tenant.id,
        locationId: pick(sedes),
        patientId,
        providerId,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
        status,
        deletedAt: deleted ? new Date('2026-10-01T00:00:00Z') : null,
        arrivedAt: inClinic ? start : null,
        preArrivalStatus:
          status === AppointmentStatus.ARRIVED
            ? AppointmentStatus.SCHEDULED
            : null,
        seatedAt: seated ? start : null,
        readyForCheckoutAt:
          status === AppointmentStatus.READY_FOR_CHECKOUT ? start : null,
      });
    }
  }

  await raw.patient.createMany({ data: patientRows });
  await raw.patientRecall.createMany({ data: recallRows });
  await raw.appointment.createMany({ data: appointmentRows });
  // Uno a uno: el trigger pone `createdAt`, así cada contacto lleva el suyo.
  for (const row of contactRows) {
    await raw.recallContact.create({ data: row });
  }
  return {
    tenantId: tenant.id,
    sedes,
    authorId: author.id,
    recallIds: new Set(recallRows.map((r) => r.id as string)),
  };
}

interface Scope {
  label: string;
  locationId?: string;
  allowed?: readonly string[];
}

const scopesOf = (c: Clinic, other: Clinic): Scope[] => [
  { label: 'todas las sedes' },
  { label: 'sede activa UTC+14', locationId: c.sedes[0] },
  { label: 'sede activa UTC−11', locationId: c.sedes[2] },
  { label: 'restringido a dos sedes', allowed: [c.sedes[1], c.sedes[2]] },
  { label: 'sin sedes permitidas', allowed: [] },
  { label: 'sede de la otra clínica', locationId: other.sedes[0] },
];

function asRequest<T>(c: Clinic, scope: Scope, fn: () => Promise<T>) {
  return tenantContext.run(c.tenantId, scope.locationId, fn, scope.allowed);
}

const both = (c: Clinic, scope: Scope, query: RecallDueQuery) =>
  asRequest(c, scope, async () => ({
    actual: await repository.listDue(query),
    expected: await prisma.runWithTenant((tx) =>
      referenceListDue(tx, query, tenantContext.scopeLocationIds()),
    ),
  }));

interface PlanNode {
  'Index Name'?: string;
  'Relation Name'?: string;
  'Node Type': string;
  Plans?: PlanNode[];
}
const nodes = (plan: PlanNode): PlanNode[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(nodes),
];

describe('lista de recall en la BD: equivalencia y aislamiento (int, DX-547)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await raw.user.deleteMany({
      where: { email: { in: SUBDOMAINS.map((s) => `recepcion@${s}.test`) } },
    });
    a = await seedClinic(SUBDOMAINS[0], 450, 547);
    b = await seedClinic(SUBDOMAINS[1], 120, 79);
    await raw.$executeRawUnsafe('ANALYZE "appointments"');
    await raw.$executeRawUnsafe('ANALYZE "patient_recalls"');
    await raw.$executeRawUnsafe('ANALYZE "patients"');
  }, 120_000);

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await raw.user.deleteMany({
      where: { id: { in: [a?.authorId, b?.authorId].filter(Boolean) } },
    });
    await Promise.all([raw.$disconnect(), prisma.$disconnect()]);
  });

  it('los datos cubren cada caso (si no, la equivalencia no prueba nada)', async () => {
    const page = (sort: RecallDueSort) =>
      asRequest(a, { label: 'todas' }, () =>
        repository.listDue({
          withinDays: 60,
          sort,
          page: 1,
          pageSize: 100,
          now: NOW,
        }),
      );
    const most = await page('MOST_OVERDUE');
    const least = await page('LEAST_OVERDUE');
    const all = { rows: [...most.rows, ...least.rows] };
    const days = all.rows.map((r) => r.daysOverdue);
    expect(most.total).toBeGreaterThan(100);
    expect(days.some((d) => d > 0)).toBe(true); // vencidos
    expect(days.some((d) => d < 0)).toBe(true); // vencen pronto
    expect(new Set(all.rows.map((r) => r.locationId)).size).toBe(3);
    expect(all.rows.some((r) => r.lastContact !== null)).toBe(true);
    expect(all.rows.some((r) => r.reminderOptedOut)).toBe(true);
    // Hay recall vencidos que NO salen por cita futura o en clínica.
    const live = await raw.$queryRaw<{ n: number }[]>`
      SELECT count(DISTINCT pr."id")::int AS n
        FROM "patient_recalls" pr
        JOIN "appointments" ap
          ON ap."tenantId" = pr."tenantId" AND ap."patientId" = pr."patientId"
       WHERE pr."tenantId" = ${a.tenantId}::uuid AND pr."active"
         AND ap."deletedAt" IS NULL
         AND ap."status" IN ('ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')`;
    expect(live[0].n).toBeGreaterThan(0);
  });

  it.each(
    NOWS.map((now) => [
      civil(now) + 'T' + now.toISOString().slice(11, 16),
      now,
    ]),
  )(
    'mismo total y mismas filas que la consulta de DX-015 (now = %s)',
    async (_label, now) => {
      let compared = 0;
      for (const [clinic, other] of [
        [a, b],
        [b, a],
      ] as const) {
        for (const scope of scopesOf(clinic, other)) {
          for (const kind of [
            undefined,
            RecallKind.HYGIENE,
            RecallKind.CHECKUP,
          ]) {
            for (const sort of [
              'MOST_OVERDUE',
              'LEAST_OVERDUE',
            ] as RecallDueSort[]) {
              for (const withinDays of [0, 15, 60]) {
                // Páginas de 100 hasta pasar del final (la vacía también).
                for (let page = 1; ; page += 1) {
                  const query = {
                    kind,
                    withinDays,
                    sort,
                    page,
                    pageSize: 100,
                    now,
                  };
                  const { actual, expected } = await both(clinic, scope, query);
                  expect({ scope: scope.label, query, ...actual }).toEqual({
                    scope: scope.label,
                    query,
                    ...expected,
                  });
                  compared += actual.rows.length;
                  if (expected.rows.length === 0) break;
                }
              }
            }
          }
        }
      }
      expect(compared).toBeGreaterThan(0);
    },
    120_000,
  );

  it('página a página (de 7) coincide con la de DX-015, y la página fuera de rango trae el total', async () => {
    for (const sort of ['MOST_OVERDUE', 'LEAST_OVERDUE'] as RecallDueSort[]) {
      const first = await both(
        a,
        { label: 'todas' },
        {
          withinDays: 60,
          sort,
          page: 1,
          pageSize: 7,
          now: NOW,
        },
      );
      const pages = Math.ceil(first.expected.total / 7);
      expect(pages).toBeGreaterThan(5);
      const seen: RecallDueRow[] = [];
      for (let page = 1; page <= pages + 1; page += 1) {
        const { actual, expected } = await both(
          a,
          { label: 'todas' },
          {
            withinDays: 60,
            sort,
            page,
            pageSize: 7,
            now: NOW,
          },
        );
        expect(actual).toEqual(expected);
        seen.push(...actual.rows);
      }
      expect(seen).toHaveLength(first.expected.total);
      expect(new Set(seen.map((r) => r.recallId)).size).toBe(seen.length);
    }
  });

  it('nunca otra clínica: ningún recall de B sale en A, ni con la sede de B en la cabecera', async () => {
    for (const scope of scopesOf(a, b)) {
      const out = await asRequest(a, scope, () =>
        repository.listDue({
          withinDays: 60,
          sort: 'MOST_OVERDUE',
          page: 1,
          pageSize: 100,
          now: NOW,
        }),
      );
      for (const row of out.rows) {
        expect(a.recallIds.has(row.recallId)).toBe(true);
        expect(b.recallIds.has(row.recallId)).toBe(false);
      }
    }
    const foreign = await asRequest(
      a,
      { label: 'sede de B', locationId: b.sedes[0] },
      () =>
        repository.listDue({
          withinDays: 60,
          sort: 'MOST_OVERDUE',
          page: 1,
          pageSize: 100,
          now: NOW,
        }),
    );
    expect(foreign).toEqual({ rows: [], total: 0 });
  });

  it('la RLS sola ya lo impide: la consulta con el id de A desde la sesión de B no devuelve nada', async () => {
    const leaked = await prisma.runWithTenant(b.tenantId, (tx) =>
      tx.$queryRaw<{ total: number; recallId: string | null }[]>(
        recallDueSql({
          tenantId: a.tenantId,
          withinDays: 60,
          sort: 'MOST_OVERDUE',
          page: 1,
          pageSize: 100,
          now: NOW,
        }),
      ),
    );
    expect(leaked).toEqual([
      expect.objectContaining({ total: 0, recallId: null }),
    ]);
  });

  it('una sola evaluación: recorre patient_recalls una vez y la cita futura usa el índice parcial', async () => {
    const plan = await prisma.runWithTenant(a.tenantId, async (tx) => {
      // Como la auditoría (DB-079): sin Seq Scan, se ve qué índice elegiría.
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      const rows = await tx.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
        Prisma.sql`EXPLAIN (FORMAT JSON) ${recallDueSql({
          tenantId: a.tenantId,
          locationIds: [a.sedes[0]],
          withinDays: 15,
          sort: 'MOST_OVERDUE',
          page: 2,
          pageSize: 25,
          now: NOW,
        })}`,
      );
      return nodes(rows[0]['QUERY PLAN'][0].Plan);
    });
    expect(
      plan.filter((n) => n['Relation Name'] === 'patient_recalls'),
    ).toHaveLength(1);
    expect(
      plan.filter((n) => n['Relation Name'] === 'recall_contacts'),
    ).toHaveLength(1);
    expect(plan.map((n) => n['Index Name'])).toContain(
      'appointments_tenant_patient_upcoming_idx',
    );
    expect(plan.map((n) => n['Index Name'])).not.toContain(
      'appointments_tenant_start_live_idx',
    );
  });
});
