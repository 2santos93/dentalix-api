import { randomUUID } from 'node:crypto';
import {
  AppointmentStatus,
  Prisma,
  PrismaClient,
  RecallKind,
} from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaRecallRepository } from '../src/modules/recall/infrastructure/prisma-recall.repository';
import type {
  RecallDueQuery,
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

// DX-015-bis · el relleno del despliegue (`dx_recall_backfill`, el que llama
// la migración 20261212090100 por clínica), sobre Postgres:
//  - congela la base: sobre los MISMOS datos, la lista con la regla nueva
//    después del relleno es exactamente la que daba la regla vieja (la última
//    cita atendida reiniciaba el reloj) antes: nadie entra ni sale, con los
//    mismos vencimientos, en sedes de zonas extremas (UTC+14 y UTC−11);
//  - aplica el historial de DONE de los disparadores (greatest);
//  - crea los recalls de source BACKFILL de pacientes vivos con un DONE de un
//    disparador en los últimos 24 meses (D3), y solo esos.
// `raw` (DIRECT_URL, owner) siembra, rellena (como la migración, con la
// clínica en la sesión) y limpia; la lista se lee como dentalix_app.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repository = new PrismaRecallRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx015bis-relleno', 'dx015bis-relleno-casos'];
const EMAIL = `odontologa@${SUBDOMAINS[0]}.test`;
const DAY_MS = 86_400_000;
const NOW = new Date('2027-04-10T11:30:00.000Z');
const ZONES = ['Pacific/Kiritimati', 'America/Caracas', 'Pacific/Pago_Pago'];
const civil = (d: Date) => d.toISOString().slice(0, 10);
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);

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
  types: DefaultRecallTypes;
}

async function clinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const sedes: string[] = [];
  for (const [i, timeZone] of ZONES.entries()) {
    sedes.push(
      (
        await raw.location.create({
          data: locationData(REGIONAL_CARACAS_FIXTURE, {
            tenantId: tenant.id,
            name: `Sede ${i + 1}`,
            timeZone,
          }),
        })
      ).id,
    );
  }
  await raw.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: 'PREV-PROFILAXIS',
      kind: 'PROCEDURE',
      labelEs: 'Profilaxis',
      color: '#0E7490',
    },
  });
  const types = await seedDefaultRecallTypes(raw, tenant.id);
  return { tenantId: tenant.id, sedes, types };
}

/** Como la migración: la clínica en la sesión y la función del relleno. */
async function backfill(c: Clinic, now = NOW): Promise<number> {
  return raw.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${c.tenantId}, true)`;
    const [row] = await tx.$queryRaw<{ created: number }[]>`
      SELECT public.dx_recall_backfill(${c.tenantId}::uuid, 24, ${now}::timestamptz) AS created`;
    return row.created;
  });
}

/**
 * Recalls «de antes» (fijados a mano, sin `manualDoneAt`), citas atendidas,
 * futuras y en clínica repartidas por las tres sedes, sin ningún DONE: la
 * regla vieja y la nueva solo difieren en la visita atendida.
 */
async function seedRandom(c: Clinic, patients: number, seed: number) {
  const rnd = mulberry32(seed);
  const int = (min: number, max: number) =>
    min + Math.floor(rnd() * (max - min + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];
  const author = randomUUID();
  const patientRows: Prisma.PatientCreateManyInput[] = [];
  const recallRows: Prisma.PatientRecallCreateManyInput[] = [];
  const appointmentRows: Prisma.AppointmentCreateManyInput[] = [];
  for (let i = 0; i < patients; i += 1) {
    const patientId = randomUUID();
    patientRows.push({
      id: patientId,
      tenantId: c.tenantId,
      firstName: pick(['Ana', 'Luis', 'María', 'José']),
      lastName: pick(['Pérez', 'Gómez', 'Díaz', 'Núñez']),
      deletedAt: rnd() < 0.05 ? new Date('2026-06-01T00:00:00Z') : null,
    });
    for (const kind of [RecallKind.HYGIENE, RecallKind.CHECKUP]) {
      if (rnd() >= 0.7) continue;
      recallRows.push({
        id: randomUUID(),
        tenantId: c.tenantId,
        patientId,
        recallTypeId: c.types[kind],
        kind,
        intervalMonths: pick([3, 6, 6, 12]),
        lastDoneAt: DAY(civil(new Date(NOW.getTime() - int(0, 900) * DAY_MS))),
        locationId: pick(c.sedes),
        active: rnd() < 0.9,
        createdById: author,
        updatedById: author,
      });
    }
    const used = new Set<number>();
    for (let k = int(0, 4); k > 0; k -= 1) {
      const r = rnd();
      const status =
        r < 0.65
          ? AppointmentStatus.COMPLETED
          : r < 0.8
            ? AppointmentStatus.SCHEDULED
            : AppointmentStatus.CANCELLED;
      const day =
        status === AppointmentStatus.SCHEDULED ? int(1, 60) : -int(1, 700);
      if (used.has(day)) continue;
      used.add(day);
      // Horas cerca de la medianoche UTC: el día civil cambia entre sedes.
      const start = new Date(
        DAY(civil(NOW)).getTime() +
          day * DAY_MS +
          pick([0, 1, 10, 13, 23]) * 3_600_000,
      );
      appointmentRows.push({
        id: randomUUID(),
        tenantId: c.tenantId,
        locationId: pick(c.sedes),
        patientId,
        providerId: randomUUID(),
        start,
        end: new Date(start.getTime() + 30 * 60_000),
        status,
        deletedAt: rnd() < 0.05 ? new Date('2026-10-01T00:00:00Z') : null,
      });
    }
  }
  await raw.patient.createMany({ data: patientRows });
  await raw.patientRecall.createMany({ data: recallRows });
  await raw.appointment.createMany({ data: appointmentRows });
}

interface Scope {
  label: string;
  locationId?: string;
}
const scopes = (c: Clinic): Scope[] => [
  { label: 'consolidada' },
  ...c.sedes.map((locationId, i) => ({ label: `sede ${i + 1}`, locationId })),
];

const queries = (): RecallDueQuery[] =>
  (['MOST_OVERDUE', 'LEAST_OVERDUE'] as RecallDueSort[]).flatMap((sort) =>
    [0, 15, 60].map((withinDays) => ({
      withinDays,
      sort,
      page: 1,
      pageSize: 100,
      now: NOW,
    })),
  );

/** Todas las páginas de la lista, como la ve recepción en cada vista. */
async function everything(
  c: Clinic,
  list: (query: RecallDueQuery) => Promise<{ rows: unknown[]; total: number }>,
) {
  const out: Record<string, unknown> = {};
  for (const scope of scopes(c)) {
    for (const base of queries()) {
      const rows: unknown[] = [];
      let total = 0;
      for (let page = 1; ; page += 1) {
        const got = await tenantContext.run(c.tenantId, scope.locationId, () =>
          list({ ...base, page }),
        );
        total = got.total;
        rows.push(...got.rows);
        if (got.rows.length < base.pageSize) break;
      }
      out[`${scope.label} ${base.sort} ${base.withinDays}`] = { total, rows };
    }
  }
  return out;
}

describe('DX-015-bis · relleno del despliegue (int)', () => {
  let a: Clinic;
  let f: Clinic;
  let userId: string;
  let membershipId: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await raw.user.deleteMany({ where: { email: EMAIL } });
    a = await clinic(SUBDOMAINS[0]);
    await seedRandom(a, 400, 15);
    f = await clinic(SUBDOMAINS[1]);
    const user = await raw.user.create({
      data: { email: EMAIL, passwordHash: 'x', fullName: 'Dra. Rondón' },
    });
    userId = user.id;
    membershipId = (
      await raw.clinicMembership.create({
        data: { tenantId: f.tenantId, userId, role: 'DENTIST' },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await raw.user.deleteMany({ where: { email: EMAIL } });
    await Promise.all([raw.$disconnect(), prisma.$disconnect()]);
  });

  it('sobre los mismos datos, la lista nueva tras el relleno = la vieja antes (nadie entra ni sale, mismos vencimientos)', async () => {
    const before = await everything(a, (query) =>
      prisma.runWithTenant((tx) =>
        referenceListDue(tx, query, tenantContext.scopeLocationIds(), 'DX-015'),
      ),
    );
    // Sin relleno, la regla nueva SÍ cambia la lista (la prueba no es vacía).
    const unfrozen = await everything(a, (query) => repository.listDue(query));
    expect(unfrozen).not.toEqual(before);

    await expect(backfill(a)).resolves.toBe(0);
    const after = await everything(a, (query) => repository.listDue(query));
    expect(after).toEqual(before);
    const totals = Object.values(before as Record<string, { total: number }>);
    expect(totals.some((t) => t.total > 50)).toBe(true);

    // Lo congelado queda como lo fijado: un CLEAR posterior no lo deshace.
    const unfrozenRows = await raw.patientRecall.count({
      where: {
        tenantId: a.tenantId,
        OR: [{ manualDoneAt: null }, { source: { not: 'MANUAL' } }],
      },
    });
    expect(unfrozenRows).toBe(0);
  }, 300_000);

  describe('historial de DONE y recalls nuevos (casos fijos)', () => {
    const K = () => f.sedes[0];
    const CCS = () => f.sedes[1];
    async function patient(name: string, archived = false) {
      return (
        await raw.patient.create({
          data: {
            tenantId: f.tenantId,
            firstName: name,
            lastName: 'Relleno',
            deletedAt: archived ? new Date('2027-01-01T00:00:00Z') : null,
          },
        })
      ).id;
    }
    async function prophylaxisDone(
      patientId: string,
      completedAt: string,
      locationId: string,
    ) {
      const catalogItem = await raw.dentalCatalogItem.findFirstOrThrow({
        where: { tenantId: f.tenantId, code: 'PREV-PROFILAXIS' },
      });
      const plan = await raw.treatmentPlan.create({
        data: { tenantId: f.tenantId, patientId, currency: 'USD' },
      });
      return (
        await raw.treatmentPlanItem.create({
          data: {
            tenantId: f.tenantId,
            planId: plan.id,
            toothNumber: '11',
            catalogItemId: catalogItem.id,
            price: 40,
            status: 'DONE',
            completedAt: new Date(completedAt),
            performedLocationId: locationId,
            performedById: userId,
            performedByMembershipId: membershipId,
          },
        })
      ).id;
    }
    const manualRecall = (patientId: string, lastDoneAt: string) =>
      raw.patientRecall.create({
        data: {
          tenantId: f.tenantId,
          patientId,
          recallTypeId: f.types.HYGIENE,
          kind: 'HYGIENE',
          intervalMonths: 6,
          lastDoneAt: DAY(lastDoneAt),
          locationId: CCS(),
          createdById: userId,
          updatedById: userId,
        },
      });
    const recalls = (patientId: string) =>
      raw.patientRecall.findMany({ where: { patientId } });

    let ids: Record<string, string>;
    let items: Record<string, string>;
    let created: number;

    beforeAll(async () => {
      ids = {
        posterior: await patient('Posterior'),
        anterior: await patient('Anterior'),
        reciente: await patient('Reciente'),
        frontera: await patient('Frontera'),
        antiguo: await patient('Antiguo'),
        archivado: await patient('Archivado', true),
      };
      // Recall fijado el 01/06/2026 y una profilaxis posterior (01/02/2027
      // 10:30 UTC = 02/02 00:30 en Kiritimati): la base pasa al día civil de
      // la sede del DONE, no al UTC.
      await manualRecall(ids.posterior, '2026-06-01');
      items = {
        posterior: await prophylaxisDone(
          ids.posterior,
          '2027-02-01T10:30:00.000Z',
          K(),
        ),
      };
      // Un DONE anterior a lo fijado no lo mueve.
      await manualRecall(ids.anterior, '2026-12-01');
      await prophylaxisDone(ids.anterior, '2026-03-01T15:00:00.000Z', CCS());
      // Sin recall: DONE hace 8 meses (22:30 del 09/08/2026 en Caracas).
      items.reciente = await prophylaxisDone(
        ids.reciente,
        '2026-08-10T02:30:00.000Z',
        CCS(),
      );
      // Justo dentro del horizonte (hace 24 meses menos un día) y fuera.
      items.frontera = await prophylaxisDone(
        ids.frontera,
        '2025-04-11T15:00:00.000Z',
        CCS(),
      );
      await prophylaxisDone(ids.antiguo, '2025-04-09T15:00:00.000Z', CCS());
      await prophylaxisDone(ids.archivado, '2026-12-01T15:00:00.000Z', CCS());
      created = await backfill(f);
    });

    it('un DONE de un disparador posterior a lo fijado mueve la base (día civil de su sede)', async () => {
      expect(await recalls(ids.posterior)).toEqual([
        expect.objectContaining({
          source: 'MANUAL',
          manualDoneAt: DAY('2026-06-01'),
          lastDoneAt: DAY('2027-02-02'),
          dueAt: DAY('2027-08-02'),
          lastDoneItemId: items.posterior,
        }),
      ]);
      expect(await recalls(ids.anterior)).toEqual([
        expect.objectContaining({
          lastDoneAt: DAY('2026-12-01'),
          lastDoneItemId: null,
        }),
      ]);
    });

    it('crea los de pacientes vivos con un DONE en los últimos 24 meses (BACKFILL, sede e intervalo del tipo), y solo esos', async () => {
      expect(created).toBe(2);
      expect(await recalls(ids.reciente)).toEqual([
        expect.objectContaining({
          source: 'BACKFILL',
          recallTypeId: f.types.HYGIENE,
          kind: 'HYGIENE',
          intervalMonths: 6,
          lastDoneAt: DAY('2026-08-09'),
          dueAt: DAY('2027-02-09'),
          manualDoneAt: null,
          lastDoneItemId: items.reciente,
          locationId: CCS(),
          createdById: userId,
        }),
      ]);
      expect(await recalls(ids.frontera)).toEqual([
        expect.objectContaining({
          source: 'BACKFILL',
          lastDoneItemId: items.frontera,
        }),
      ]);
      expect(await recalls(ids.antiguo)).toEqual([]);
      expect(await recalls(ids.archivado)).toEqual([]);
    });

    it('el creado sale vencido en la lista (como cualquier otro) y se puede deshacer por su source', async () => {
      const out = await tenantContext.run(f.tenantId, undefined, () =>
        repository.listDue({
          withinDays: 0,
          sort: 'MOST_OVERDUE',
          page: 1,
          pageSize: 100,
          now: NOW,
        }),
      );
      expect(out.rows.map((r) => r.patientFirstName)).toContain('Reciente');
      const undo = await raw.patientRecall.deleteMany({
        where: {
          tenantId: f.tenantId,
          source: 'BACKFILL',
          contacts: { none: {} },
        },
      });
      expect(undo.count).toBe(2);
    });
  });
});
