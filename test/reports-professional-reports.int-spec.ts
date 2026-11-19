import { randomUUID } from 'node:crypto';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaProfessionalReportsRepository } from '../src/modules/reports/infrastructure/prisma-professional-reports.repository';
import { GetProfessionalProductivityUseCase } from '../src/modules/reports/application/use-cases/get-professional-productivity.use-case';
import { GetNoShowsUseCase } from '../src/modules/reports/application/use-cases/get-no-shows.use-case';
import { resetDatabase } from './support/e2e-fixtures';
import { ReportSeeder } from './support/reports-fixtures';

// DX-304 · «Profesionales» e «Inasistencias» contra Postgres de verdad, como
// dentalix_app (DATABASE_URL, sin BYPASSRLS) con la clínica fijada por
// runWithTenant. `raw` (DIRECT_URL, owner) solo siembra, con fechas fijas
// (sedes en America/Caracas, UTC−4): nada depende del reloj.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const NOVEMBER = { from: '2026-11-01', to: '2026-11-30' };

const SOURCE_TABLES = [
  'locations',
  'appointments',
  'payments',
  'payment_allocations',
  'treatment_plans',
  'treatment_plan_items',
  'patients',
  'clinic_memberships',
];

/** Imputaciones y su base sin los triggers (fechas y montos exactos). */
function withoutTriggers<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return raw.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    return fn(tx);
  });
}

interface Clinic {
  tenantId: string;
  norte: string;
  sur: string;
  dentistId: string;
  otherId: string;
  /** Ítem USD de la dentista en Norte (el que se cobra). */
  usdItem: { planId: string; itemId: string; patientId: string };
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const seed = new ReportSeeder(raw, tenant.id);
  const norte = await seed.location('Sede Norte');
  const sur = await seed.location('Sede Sur');
  const dentist = await seed.dentist();
  const otherId = await seed.provider(`Dr. Otro ${subdomain}`);
  const otherMembership = await raw.clinicMembership.findFirstOrThrow({
    where: { tenantId: tenant.id, userId: otherId },
  });
  const patientId = await seed.patient(`Pérez ${subdomain}`);
  const itemOf = async (planId: string) =>
    (
      await raw.treatmentPlanItem.findFirstOrThrow({
        where: { tenantId: tenant.id, planId },
      })
    ).id;

  // Dentista: 100 − 10 en USD (Norte) y 3650 en VES (Sur) en noviembre;
  // 50 USD a las 23:30 del 31/10 en Caracas (03:30 UTC del 1/11): octubre.
  const usdPlan = await seed.plan({
    patientId,
    currency: 'USD',
    price: 100,
    discount: 10,
    done: { locationId: norte, at: new Date('2026-11-05T15:00:00Z') },
  });
  await seed.plan({
    patientId,
    currency: 'VES',
    price: 3650,
    done: { locationId: sur, at: new Date('2026-11-06T15:00:00Z') },
  });
  await seed.plan({
    patientId,
    currency: 'USD',
    price: 50,
    done: { locationId: norte, at: new Date('2026-11-01T03:30:00Z') },
  });
  // Retirado: no cuenta.
  const deletedPlan = await seed.plan({
    patientId,
    currency: 'USD',
    price: 999,
    done: { locationId: norte, at: new Date('2026-11-05T16:00:00Z') },
  });
  await raw.treatmentPlanItem.updateMany({
    where: { tenantId: tenant.id, planId: deletedPlan },
    data: { deletedAt: new Date('2026-11-06T00:00:00Z') },
  });
  // «Sin atribuir» (sin quién ni dónde): no es de nadie.
  await seed.unattributedDone({ patientId, currency: 'USD', price: 77 });

  // El otro profesional: 40 USD en Norte.
  const otherPlan = await raw.treatmentPlan.create({
    data: {
      tenantId: tenant.id,
      patientId,
      currency: 'USD',
      status: 'ACCEPTED',
    },
  });
  await raw.treatmentPlanItem.create({
    data: {
      tenantId: tenant.id,
      planId: otherPlan.id,
      toothNumber: '21',
      catalogItemId: (
        await raw.treatmentPlanItem.findFirstOrThrow({
          where: { tenantId: tenant.id, planId: usdPlan },
        })
      ).catalogItemId,
      price: 40,
      status: 'DONE',
      performedById: otherId,
      performedByMembershipId: otherMembership.id,
      performedLocationId: norte,
      completedAt: new Date('2026-11-10T15:00:00Z'),
    },
  });

  // Cobros del ítem USD: 60 vivo el 7/11 y 20 anulado (no cuenta).
  const usdItemId = await itemOf(usdPlan);
  const pay = async (amount: number, voided: boolean) =>
    withoutTriggers(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          tenantId: tenant.id,
          locationId: norte,
          treatmentPlanId: usdPlan,
          patientId,
          amount,
          currency: 'USD',
          paidAt: new Date('2026-11-07T15:00:00Z'),
          ...(voided ? { voidedAt: new Date('2026-11-08T15:00:00Z') } : {}),
        },
      });
      await tx.paymentPlanAmount.create({
        data: {
          paymentId: payment.id,
          tenantId: tenant.id,
          treatmentPlanId: usdPlan,
          amount,
          currency: 'USD',
          rateDate: new Date('2026-11-07'),
        },
      });
      await tx.paymentAllocation.create({
        data: {
          id: randomUUID(),
          tenantId: tenant.id,
          paymentId: payment.id,
          treatmentPlanId: usdPlan,
          treatmentPlanItemId: usdItemId,
          amount,
          source: 'AUTO',
        },
      });
    });
  await pay(60, false);
  await pay(20, true);

  // Agenda de la dentista en Norte: atendida, no asistió, tardía y a tiempo.
  await seed.appointment({
    locationId: norte,
    patientId,
    day: '2026-11-05',
    status: 'COMPLETED',
  });
  await seed.appointment({
    locationId: norte,
    patientId,
    day: '2026-11-06',
    status: 'NO_SHOW',
  });
  await seed.appointment({
    locationId: norte,
    patientId,
    day: '2026-11-07',
    status: 'CANCELLED',
    lateCancellation: true,
  });
  await seed.appointment({
    locationId: norte,
    patientId,
    day: '2026-11-08',
    status: 'CANCELLED',
    lateCancellation: false,
  });
  // Del otro: una atendida en Norte.
  await raw.appointment.create({
    data: {
      tenantId: tenant.id,
      locationId: norte,
      patientId,
      providerId: otherId,
      start: new Date('2026-11-10T17:00:00Z'),
      end: new Date('2026-11-10T17:30:00Z'),
      status: 'COMPLETED',
    },
  });
  return {
    tenantId: tenant.id,
    norte,
    sur,
    dentistId: dentist.userId,
    otherId,
    usdItem: { planId: usdPlan, itemId: usdItemId, patientId },
  };
}

describe('«Profesionales» e «Inasistencias» en la BD (DX-304, int)', () => {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const repo = new PrismaProfessionalReportsRepository(prisma, context);
  const productivity = new GetProfessionalProductivityUseCase(repo);
  const noShows = new GetNoShowsUseCase(repo);
  let a: Clinic;
  let b: Clinic;
  const admin = () => ({
    userId: a.dentistId,
    role: ClinicRole.ADMIN,
    permissions: [],
  });

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(raw);
    a = await seedClinic('dx304-a');
    b = await seedClinic('dx304-b');
  }, 180_000);

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await raw.$disconnect();
  });

  it('corre como dentalix_app, sin BYPASSRLS, y las tablas que lee tienen RLS forzada', async () => {
    const [who] = await prisma.$queryRaw<{ role: string; bypass: boolean }[]>`
      SELECT current_user AS role, rolbypassrls AS bypass
        FROM pg_roles WHERE rolname = current_user`;
    expect(who).toEqual({ role: 'dentalix_app', bypass: false });
    const rows = await raw.$queryRaw<
      { relname: string; enabled: boolean; forced: boolean }[]
    >`SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relname = ANY(${SOURCE_TABLES})`;
    expect(rows.map((r) => r.relname).sort()).toEqual(
      [...SOURCE_TABLES].sort(),
    );
    expect(rows.filter((r) => !r.enabled || !r.forced)).toEqual([]);
  });

  it('la producción de cada profesional cuadra con la suma de sus ítems realizados del período', async () => {
    const report = await context.run(a.tenantId, () =>
      productivity.execute({
        ...NOVEMBER,
        actor: admin(),
        allowedLocationIds: 'ALL',
      }),
    );
    // La suma «a mano», independiente del reporte: ítems DONE vivos de
    // planes vivos, de quien los realizó, con el día civil de Caracas en
    // noviembre.
    const expected = await raw.$queryRaw<
      { userId: string; currency: string; count: bigint; net: Prisma.Decimal }[]
    >`SELECT i."performedById" AS "userId", p."currency", count(*) AS "count",
             sum(i."price" - i."discount") AS "net"
        FROM "treatment_plan_items" i
        JOIN "treatment_plans" p ON p."id" = i."planId"
       WHERE i."tenantId" = ${a.tenantId}::uuid AND i."status" = 'DONE'
         AND i."deletedAt" IS NULL AND p."deletedAt" IS NULL
         AND i."performedById" IS NOT NULL
         AND (i."completedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Caracas')::date
             BETWEEN '2026-11-01' AND '2026-11-30'
       GROUP BY 1, 2`;
    const actual = report.rows.flatMap((r) =>
      r.production.map((p) => ({
        userId: r.professionalId,
        currency: p.currency,
        count: p.count,
        net: p.net,
      })),
    );
    expect(
      actual.sort((x, y) =>
        (x.userId + x.currency).localeCompare(y.userId + y.currency),
      ),
    ).toEqual(
      expected
        .map((e) => ({
          userId: e.userId,
          currency: e.currency,
          count: Number(e.count),
          net: e.net.toNumber(),
        }))
        .sort((x, y) =>
          (x.userId + x.currency).localeCompare(y.userId + y.currency),
        ),
    );
    const dentist = report.rows.find((r) => r.professionalId === a.dentistId);
    expect(dentist).toMatchObject({
      production: [
        { currency: 'USD', count: 1, net: 90 },
        { currency: 'VES', count: 1, net: 3650 },
      ],
      collected: [{ currency: 'USD', amount: 60 }],
      completedAppointments: 1,
      noShows: 1,
      lateCancellations: 1,
      noShowRate: 33.33,
    });
    expect(report.totals.production).toEqual([
      { currency: 'USD', count: 2, net: 130 },
      { currency: 'VES', count: 1, net: 3650 },
    ]);
    expect(report.totals.completedAppointments).toBe(2);
  });

  it('con una sede, solo lo realizado y las citas de esa sede', async () => {
    const report = await context.run(a.tenantId, () =>
      productivity.execute({
        ...NOVEMBER,
        locationId: a.sur,
        actor: admin(),
        allowedLocationIds: 'ALL',
      }),
    );
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      professionalId: a.dentistId,
      production: [{ currency: 'VES', count: 1, net: 3650 }],
      collected: [],
      completedAppointments: 0,
      noShowRate: null,
    });
  });

  it('un DENTIST solo recibe su fila (el filtro va en la consulta)', async () => {
    const report = await context.run(a.tenantId, () =>
      productivity.execute({
        ...NOVEMBER,
        actor: { userId: a.otherId, role: ClinicRole.DENTIST, permissions: [] },
        allowedLocationIds: 'ALL',
      }),
    );
    expect(report.scope).toBe('OWN');
    expect(report.rows.map((r) => r.professionalId)).toEqual([a.otherId]);
    expect(report.totals.production).toEqual([
      { currency: 'USD', count: 1, net: 40 },
    ]);
    expect(report.options.professionals.map((p) => p.userId)).toEqual([
      a.otherId,
    ]);
  });

  it('«Inasistencias»: % de kpi-definitions y la lista de no asistidas y tardías, la más reciente primero', async () => {
    const report = await context.run(a.tenantId, () =>
      noShows.execute({
        ...NOVEMBER,
        actor: admin(),
        allowedLocationIds: 'ALL',
      }),
    );
    expect(report.summary).toEqual({
      completedAppointments: 2,
      noShows: 1,
      lateCancellations: 1,
      noShowRate: 25,
    });
    expect(report.total).toBe(2);
    expect(report.items.map((i) => i.kind)).toEqual([
      'LATE_CANCELLATION',
      'NO_SHOW',
    ]);
    expect(report.items[0]).toMatchObject({
      patientArchived: false,
      locationName: 'Sede Norte',
      timeZone: 'America/Caracas',
      noticeMinutes: 60,
    });
    const page2 = await context.run(a.tenantId, () =>
      noShows.execute({
        ...NOVEMBER,
        actor: admin(),
        allowedLocationIds: 'ALL',
        page: 2,
        pageSize: 1,
      }),
    );
    expect(page2.items.map((i) => i.kind)).toEqual(['NO_SHOW']);
    expect(page2.total).toBe(2);
  });

  it('la RLS sola ya aísla: sedes de B con la clínica A fijada → nada', async () => {
    const asB = new TenantContextService();
    const crossed = new PrismaProfessionalReportsRepository(prisma, asB);
    const [sums, missed, professionals] = await context.run(a.tenantId, () =>
      asB.run(b.tenantId, () =>
        Promise.all([
          crossed.sums(NOVEMBER, { locationIds: [b.norte, b.sur] }),
          crossed.listMissed(
            NOVEMBER,
            { locationIds: [b.norte] },
            { skip: 0, take: 10 },
          ),
          crossed.listProfessionals([b.norte, b.sur]),
        ]),
      ),
    );
    expect(sums.production).toEqual([]);
    expect(sums.collected).toEqual([]);
    expect(sums.attendance).toEqual([]);
    expect(missed).toEqual({ items: [], total: 0 });
    expect(professionals).toEqual([]);
  });

  it('con las sedes de otra clínica en el filtro explícito no devuelve nada de ella', async () => {
    const sums = await context.run(a.tenantId, () =>
      repo.sums(NOVEMBER, { locationIds: [b.norte, b.sur] }),
    );
    expect(sums.production).toEqual([]);
    expect(sums.attendance).toEqual([]);
  });
});
