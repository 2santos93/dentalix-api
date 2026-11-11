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
import {
  type DefaultRecallTypes,
  seedDefaultRecallTypes,
} from './support/recall-types';

// DX-547 (DB-079), capa BD: la lista de recall con el repositorio Prisma REAL
// como `dentalix_app` (DATABASE_URL, RLS FORCE). `raw` (owner, DIRECT_URL)
// solo siembra y limpia. Compara la consulta nueva (una sola sentencia, filtros
// antes de las LATERAL, índice de citas vivas del paciente) con el ORÁCULO
// `referenceListDue` (la consulta de DX-015 tal cual) sobre datos que cubren
// vencido / no vencido, con y sin cita futura, cita en clínica, varias sedes
// en zonas extremas (UTC+14 y UTC−11, el «hoy» cambia de día entre sedes),
// pacientes sin cita atendida (base = lastDoneAt), pausados, inactivos,
// archivados y dos clínicas.
//
// DX-015-bis: el oráculo es la regla nueva (la base es "lastDoneAt"; la cita
// atendida solo da la sede) y calcula el vencimiento sin leer la columna
// generada; la consulta de la app recorre `patient_recalls_tenant_due_idx`.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repository = new PrismaRecallRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx547-int-a', 'dx547-int-b', 'dx547-int-frontera'];
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
  types: DefaultRecallTypes;
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
  const types = await seedDefaultRecallTypes(raw, tenant.id);
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
        recallTypeId: types[kind],
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
    types,
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
  'Index Cond'?: string;
  'Actual Loops'?: number;
  'Actual Rows'?: number;
  Filter?: string;
  'Relation Name'?: string;
  'Node Type': string;
  Plans?: PlanNode[];
}
const nodes = (plan: PlanNode): PlanNode[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(nodes),
];

/**
 * Casos FIJOS en la frontera de las cotas de `recallDueSql` (revisión de
 * DX-547). Con NOW (11:30Z) «hoy» es el 07/11 en Kiritimati (UTC+14) y el
 * 06/11 en Pago Pago (UTC−11): `maxToday` = 2026-11-07. Cada recall es de un
 * paciente distinto (nombre = caso) sin citas salvo las indicadas.
 */
interface FixedCase {
  name: string;
  sede: 'K' | 'P';
  lastDoneAt: string;
  intervalMonths: number;
  disabledUntil?: string;
  /** Visita atendida (UTC), en la sede indicada. */
  completed?: { start: string; sede: 'K' | 'P' };
}
const FIXED: FixedCase[] = [
  // a) vencimiento justo en maxToday + withinDays.
  { name: 'A1', sede: 'K', lastDoneAt: '2026-05-07', intervalMonths: 6 }, // 11-07 = hoy K
  { name: 'A2', sede: 'P', lastDoneAt: '2026-05-07', intervalMonths: 6 }, // 11-07 = maxToday, pero hoy P + 1
  { name: 'A3', sede: 'K', lastDoneAt: '2026-05-22', intervalMonths: 6 }, // 11-22 = maxToday + 15
  { name: 'A4', sede: 'K', lastDoneAt: '2026-05-23', intervalMonths: 6 }, // 11-23 = maxToday + 16
  { name: 'A5', sede: 'P', lastDoneAt: '2026-05-21', intervalMonths: 6 }, // 11-21 = hoy P + 15
  { name: 'A6', sede: 'P', lastDoneAt: '2026-05-22', intervalMonths: 6 }, // 11-22: pasa la cota, no el filtro exacto
  // b) disabledUntil = hoy en Kiritimati: en Pago Pago aún no ha llegado.
  {
    name: 'B1',
    sede: 'P',
    lastDoneAt: '2026-01-01',
    intervalMonths: 6,
    disabledUntil: '2026-11-07',
  },
  {
    name: 'B2',
    sede: 'K',
    lastDoneAt: '2026-01-01',
    intervalMonths: 6,
    disabledUntil: '2026-11-07',
  },
  // c) DX-015-bis: una visita atendida posterior a lastDoneAt + intervalo ya
  // NO mueve el vencimiento (2026-01-10 en los dos); solo da la sede (P).
  {
    name: 'C1',
    sede: 'K',
    lastDoneAt: '2025-01-10',
    intervalMonths: 12,
    completed: { start: '2026-03-15T20:00:00.000Z', sede: 'P' },
  },
  {
    name: 'C2',
    sede: 'K',
    lastDoneAt: '2025-01-10',
    intervalMonths: 12,
    completed: { start: '2025-11-10T20:00:00.000Z', sede: 'P' },
  },
  // d) lastDoneAt de fin de mes + 1 mes (recorte a fin de mes).
  { name: 'D1', sede: 'K', lastDoneAt: '2026-08-31', intervalMonths: 1 }, // 2026-09-30
  { name: 'D2', sede: 'K', lastDoneAt: '2026-10-31', intervalMonths: 1 }, // 2026-11-30
];

async function seedFixed(
  subdomain: string,
): Promise<Clinic & { k: string; p: string }> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const sede = async (name: string, timeZone: string) =>
    (
      await raw.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, {
          tenantId: tenant.id,
          name,
          timeZone,
        }),
      })
    ).id;
  const k = await sede('Sede Kiritimati', 'Pacific/Kiritimati');
  const p = await sede('Sede Pago Pago', 'Pacific/Pago_Pago');
  const types = await seedDefaultRecallTypes(raw, tenant.id);
  const author = await raw.user.create({
    data: {
      email: `recepcion@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Recepción',
    },
  });
  const ids = new Set<string>();
  for (const c of FIXED) {
    const patient = await raw.patient.create({
      data: { tenantId: tenant.id, firstName: c.name, lastName: 'Frontera' },
    });
    const recall = await raw.patientRecall.create({
      data: {
        tenantId: tenant.id,
        patientId: patient.id,
        kind: RecallKind.CHECKUP,
        recallTypeId: types.CHECKUP,
        intervalMonths: c.intervalMonths,
        lastDoneAt: DAY(c.lastDoneAt),
        locationId: c.sede === 'K' ? k : p,
        disabledUntil: c.disabledUntil ? DAY(c.disabledUntil) : null,
        disabledReason: c.disabledUntil ? 'Tratamiento en curso' : null,
        createdById: author.id,
        updatedById: author.id,
      },
    });
    ids.add(recall.id);
    if (c.completed) {
      const start = new Date(c.completed.start);
      await raw.appointment.create({
        data: {
          tenantId: tenant.id,
          locationId: c.completed.sede === 'K' ? k : p,
          patientId: patient.id,
          providerId: author.id,
          start,
          end: new Date(start.getTime() + 30 * 60_000),
          status: AppointmentStatus.COMPLETED,
        },
      });
    }
  }
  return {
    tenantId: tenant.id,
    sedes: [k, p],
    authorId: author.id,
    types,
    recallIds: ids,
    k,
    p,
  };
}

describe('lista de recall en la BD: equivalencia y aislamiento (int, DX-547)', () => {
  let a: Clinic;
  let b: Clinic;
  let f: Clinic & { k: string; p: string };

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await raw.user.deleteMany({
      where: { email: { in: SUBDOMAINS.map((s) => `recepcion@${s}.test`) } },
    });
    a = await seedClinic(SUBDOMAINS[0], 450, 547);
    b = await seedClinic(SUBDOMAINS[1], 120, 79);
    f = await seedFixed(SUBDOMAINS[2]);
    await raw.$executeRawUnsafe('ANALYZE "appointments"');
    await raw.$executeRawUnsafe('ANALYZE "patient_recalls"');
    await raw.$executeRawUnsafe('ANALYZE "patients"');
  }, 120_000);

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await raw.user.deleteMany({
      where: {
        id: { in: [a?.authorId, b?.authorId, f?.authorId].filter(Boolean) },
      },
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
    'mismo total y mismas filas que el oráculo (now = %s)',
    async (_label, now) => {
      let compared = 0;
      for (const [clinic, other] of [
        [a, b],
        [b, a],
      ] as const) {
        for (const scope of scopesOf(clinic, other)) {
          for (const filter of [
            {},
            { kind: RecallKind.HYGIENE },
            { kind: RecallKind.CHECKUP },
            { recallTypeId: clinic.types.HYGIENE },
            { recallTypeId: other.types.CHECKUP },
          ]) {
            for (const sort of [
              'MOST_OVERDUE',
              'LEAST_OVERDUE',
            ] as RecallDueSort[]) {
              for (const withinDays of [0, 15, 60]) {
                // Páginas de 100 hasta pasar del final (la vacía también).
                for (let page = 1; ; page += 1) {
                  const query = {
                    ...filter,
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

  it('página a página (de 7) coincide con el oráculo, y la página fuera de rango trae el total', async () => {
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
      // Y sondas por recall (sin hash ni merge): con los pocos datos del test
      // Postgres prefiere a veces un hash de todas las citas; con volumen
      // elige solo la sonda (ver el EXPLAIN ANALYZE del informe de DX-547).
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      await tx.$executeRaw`SET LOCAL enable_hashjoin = off`;
      await tx.$executeRaw`SET LOCAL enable_mergejoin = off`;
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
  describe('casos fijos en la frontera de las cotas', () => {
    type Expected = [
      name: string,
      sede: 'K' | 'P',
      baseDate: string,
      dueAt: string,
      daysOverdue: number,
    ];
    const run = async (
      withinDays: number,
      scope: Scope = { label: 'todas' },
    ) => {
      const query: RecallDueQuery = {
        withinDays,
        sort: 'MOST_OVERDUE',
        page: 1,
        pageSize: 100,
        now: NOW,
      };
      const { actual, expected } = await both(f, scope, query);
      expect(actual).toEqual(expected);
      return actual.rows.map((r): Expected => [
        r.patientFirstName,
        r.locationId === f.k ? 'K' : 'P',
        r.baseDate,
        r.dueAt,
        r.daysOverdue,
      ]);
    };

    it('withinDays = 0: vence justo hoy en Kiritimati (A1); en Pago Pago aún no (A2); B1 sigue pausado; C1 y C2, por lo fijado', async () => {
      expect(await run(0)).toEqual<Expected[]>([
        ['C1', 'P', '2025-01-10', '2026-01-10', 300],
        ['C2', 'P', '2025-01-10', '2026-01-10', 300],
        ['B2', 'K', '2026-01-01', '2026-07-01', 129],
        ['D1', 'K', '2026-08-31', '2026-09-30', 38],
        ['A1', 'K', '2026-05-07', '2026-11-07', 0],
      ]);
    });

    it('withinDays = 15: entra lo que vence en maxToday + 15 (A3) y hoy de Pago Pago + 15 (A5); A4 y A6 no', async () => {
      expect(await run(15)).toEqual<Expected[]>([
        ['C1', 'P', '2025-01-10', '2026-01-10', 300],
        ['C2', 'P', '2025-01-10', '2026-01-10', 300],
        ['B2', 'K', '2026-01-01', '2026-07-01', 129],
        ['D1', 'K', '2026-08-31', '2026-09-30', 38],
        ['A1', 'K', '2026-05-07', '2026-11-07', 0],
        ['A2', 'P', '2026-05-07', '2026-11-07', -1],
        ['A3', 'K', '2026-05-22', '2026-11-22', -15],
        ['A5', 'P', '2026-05-21', '2026-11-21', -15],
      ]);
    });

    it('withinDays = 60: fin de mes + 1 mes recorta a 30/11 (D2)', async () => {
      expect(await run(60)).toEqual<Expected[]>([
        ['C1', 'P', '2025-01-10', '2026-01-10', 300],
        ['C2', 'P', '2025-01-10', '2026-01-10', 300],
        ['B2', 'K', '2026-01-01', '2026-07-01', 129],
        ['D1', 'K', '2026-08-31', '2026-09-30', 38],
        ['A1', 'K', '2026-05-07', '2026-11-07', 0],
        ['A2', 'P', '2026-05-07', '2026-11-07', -1],
        ['A3', 'K', '2026-05-22', '2026-11-22', -15],
        ['A5', 'P', '2026-05-21', '2026-11-21', -15],
        ['A4', 'K', '2026-05-23', '2026-11-23', -16],
        ['A6', 'P', '2026-05-22', '2026-11-22', -16],
        ['D2', 'K', '2026-10-31', '2026-11-30', -23],
      ]);
    });

    it('sede de Pago Pago: la visita atendida allí trae a C1 y C2 aunque el recall se fijó en Kiritimati', async () => {
      expect(await run(15, { label: 'Pago Pago', locationId: f.p })).toEqual<
        Expected[]
      >([
        ['C1', 'P', '2025-01-10', '2026-01-10', 300],
        ['C2', 'P', '2025-01-10', '2026-01-10', 300],
        ['A2', 'P', '2026-05-07', '2026-11-07', -1],
        ['A5', 'P', '2026-05-21', '2026-11-21', -15],
      ]);
    });
  });

  it('DX-015-bis: la cota es un rango del índice por vencimiento: del recorrido de patient_recalls salen menos recall que los activos', async () => {
    const [{ n: active }] = await prisma.runWithTenant(
      a.tenantId,
      (tx) =>
        tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "patient_recalls" WHERE "active"`,
    );
    const plan = await prisma.runWithTenant(a.tenantId, async (tx) => {
      // Con los pocos datos del test Postgres puede preferir recorrer la
      // tabla; con volumen elige el índice (test/recall-due-load.int-spec.ts).
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
      const rows = await tx.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
        Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${recallDueSql({
          tenantId: a.tenantId,
          withinDays: 0,
          sort: 'MOST_OVERDUE',
          page: 1,
          pageSize: 20,
          now: NOW,
        })}`,
      );
      return nodes(rows[0]['QUERY PLAN'][0].Plan);
    });
    // Un solo recorrido, con la cota por "dueAt" dentro (como condición del
    // índice por vencimiento o como filtro, según elija el planificador con
    // tan pocos datos; con volumen es el rango del índice, lo fija
    // test/recall-due-load.int-spec.ts): lo que sale de él (lo único que puede
    // llegar a la LATERAL de la sede) ya viene recortado.
    const scans = plan.filter((n) => n['Relation Name'] === 'patient_recalls');
    expect(scans).toHaveLength(1);
    const [scan] = scans;
    expect(`${scan['Index Cond'] ?? ''} ${scan.Filter ?? ''}`).toContain(
      '"dueAt" <=',
    );
    // Holgura: la cota sola (sin contar la cita futura) quita más de un 20 %.
    expect(
      (scan['Actual Rows'] ?? 0) * (scan['Actual Loops'] ?? 1),
    ).toBeLessThan(active * 0.8);
  });
});
