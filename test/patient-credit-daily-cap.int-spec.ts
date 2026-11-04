import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientCreditRepository } from '../src/modules/patient-credit/infrastructure/prisma-patient-credit.repository';
import { DailyRefundCapExceededError } from '../src/modules/patient-credit/domain/patient-credit';
import {
  REGIONAL_CARACAS_FIXTURE,
  REGIONAL_MADRID_FIXTURE,
  locationData,
  type RegionalFixture,
} from './support/location-fixtures';

// DX-462, capa BD: el tope diario de devoluciones de RECEPCIÓN se acumula por
// (clínica, sede, usuario, día civil de la sede, moneda) y se comprueba bajo un
// bloqueo consultivo: dos devoluciones simultáneas no pasan del tope.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repository = new PrismaPatientCreditRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx462-int-ve', 'dx462-int-es'];
const EMAILS = [
  'dx462-int-1@example.com',
  'dx462-int-2@example.com',
  'dx462-int-3@example.com',
];
const CAP = 10_000; // 100,00 en céntimos

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  paymentId: string;
  planId: string;
  /** Otro plan cancelado con saldo a favor: el bloqueo del plan no ordena las dos. */
  otherPlanId: string;
  otherPaymentId: string;
}

let ve: Seeded;
let es: Seeded;
let userA: string;
let userB: string;
let userC: string;

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length > 0) {
    const where = { tenantId: { in: ids } };
    await raw.patientCreditEntry.deleteMany({ where });
    await raw.patientCreditRefundPayment.deleteMany({ where });
    await raw.patientCreditRefund.deleteMany({ where });
    await raw.patientCreditRefundCounter.deleteMany({ where });
    await raw.paymentReceipt.deleteMany({ where });
    await raw.payment.deleteMany({ where });
    await raw.treatmentPlan.deleteMany({ where });
    await raw.patientLedger.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  await raw.user.deleteMany({ where: { email: { in: EMAILS } } });
}

async function seedCreditPlan(
  tenantId: string,
  locationId: string,
  patientId: string,
): Promise<{ planId: string; paymentId: string }> {
  const plan = await raw.treatmentPlan.create({
    data: { tenantId, patientId, currency: 'USD', status: 'ACCEPTED' },
  });
  const payment = await raw.payment.create({
    data: {
      tenantId,
      locationId,
      treatmentPlanId: plan.id,
      patientId,
      amount: 5_000,
      currency: 'USD',
      paidAt: new Date(),
      method: 'CASH',
    },
  });
  await raw.treatmentPlan.update({
    where: { id: plan.id },
    data: { status: 'CANCELLED' },
  });
  return { planId: plan.id, paymentId: payment.id };
}

async function seed(
  subdomain: string,
  regional: RegionalFixture,
  country: string,
): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: locationData(regional, {
      tenantId: tenant.id,
      name: 'Sede',
      country,
    }),
  });
  const patient = await raw.patient.create({
    data: {
      tenantId: tenant.id,
      firstName: 'Ana',
      lastName: 'Favor',
      docNumber: `${subdomain}-1`,
    },
  });
  const first = await seedCreditPlan(tenant.id, location.id, patient.id);
  const second = await seedCreditPlan(tenant.id, location.id, patient.id);
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: patient.id,
    paymentId: first.paymentId,
    planId: first.planId,
    otherPlanId: second.planId,
    otherPaymentId: second.paymentId,
  };
}

function createRefund(
  s: Seeded,
  userId: string,
  amountCents: number,
  now: Date,
  capCents: number | null = CAP,
  other = false,
) {
  return tenantContext.run(s.tenantId, s.locationId, () =>
    repository.createRefund({
      planId: other ? s.otherPlanId : s.planId,
      amountCents,
      currency: 'USD',
      method: 'TRANSFER',
      reason: 'Devolución pedida',
      paymentIds: [other ? s.otherPaymentId : s.paymentId],
      userId,
      fingerprint: 'f',
      ...(capCents === null ? {} : { dailyCap: { capCents, now } }),
    }),
  );
}

/** La devolución entra con `createdAt` = el reloj inyectado de la prueba. */
async function refund(
  s: Seeded,
  userId: string,
  amountCents: number,
  now: Date,
  capCents: number | null = CAP,
) {
  const created = await createRefund(s, userId, amountCents, now, capCents);
  await setCreatedAt(created.id, now);
  return created;
}

async function setCreatedAt(id: string, at: Date): Promise<void> {
  // Tabla append-only (DX-253): el superusuario de la prueba salta el trigger.
  await raw.$transaction([
    raw.$executeRaw`SET LOCAL session_replication_role = replica`,
    raw.$executeRaw`UPDATE "patient_credit_refunds" SET "createdAt" = ${at} WHERE "id" = ${id}::uuid`,
  ]);
}

describe('DX-462 · tope diario de devoluciones en la BD (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    userA = (
      await raw.user.create({
        data: { email: EMAILS[0], fullName: 'Recep A', passwordHash: 'x' },
      })
    ).id;
    userB = (
      await raw.user.create({
        data: { email: EMAILS[1], fullName: 'Recep B', passwordHash: 'x' },
      })
    ).id;
    userC = (
      await raw.user.create({
        data: { email: EMAILS[2], fullName: 'Recep C', passwordHash: 'x' },
      })
    ).id;
    ve = await seed(SUBDOMAINS[0], REGIONAL_CARACAS_FIXTURE, 'VE');
    es = await seed(SUBDOMAINS[1], REGIONAL_MADRID_FIXTURE, 'ES');
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await raw.$disconnect();
  });

  it('60 + 60 con tope 100 el mismo día de la sede: la segunda se rechaza con lo que queda', async () => {
    const now = new Date('2026-11-04T15:00:00Z');
    await refund(ve, userA, 6_000, now);
    const error = await refund(ve, userA, 6_000, now).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DailyRefundCapExceededError);
    expect((error as DailyRefundCapExceededError).remainingCents).toBe(4_000);
    // Y lo que queda sí se puede devolver.
    await refund(ve, userA, 4_000, now);
  });

  it('el tope es del usuario: otro recepcionista de la misma sede devuelve', async () => {
    const now = new Date('2026-11-04T15:00:00Z');
    await expect(refund(ve, userB, 6_000, now)).resolves.toBeDefined();
  });

  it('Caracas: 23:30 y 00:30 locales son días distintos', async () => {
    // userB ya devolvió 60 el 4 nov (ayer en Caracas respecto a «hoy» 5 nov).
    const lateCaracas = new Date('2026-11-05T03:30:00Z'); // 23:30 del 4 nov
    await refund(ve, userB, 4_000, lateCaracas); // suma 100: justo el tope
    await expect(refund(ve, userB, 1, lateCaracas)).rejects.toBeInstanceOf(
      DailyRefundCapExceededError,
    );
    // 00:30 del 5 nov en Caracas: día nuevo, el tope vuelve a cero.
    await expect(
      refund(ve, userB, 10_000, new Date('2026-11-05T04:30:00Z')),
    ).resolves.toBeDefined();
  });

  it('Madrid: 23:30 y 00:30 locales son días distintos', async () => {
    const t1 = new Date('2026-11-04T22:30:00Z'); // 23:30 del 4 nov en Madrid
    const t2 = new Date('2026-11-04T23:30:00Z'); // 00:30 del 5 nov
    await refund(es, userA, 10_000, t1);
    await expect(refund(es, userA, 1, t1)).rejects.toBeInstanceOf(
      DailyRefundCapExceededError,
    );
    await expect(refund(es, userA, 10_000, t2)).resolves.toBeDefined();
  });

  it('sin dailyCap (ADMIN) no hay tope', async () => {
    const now = new Date('2026-11-04T15:00:00Z');
    await expect(refund(es, userB, 50_000, now, null)).resolves.toBeDefined();
    await expect(refund(es, userB, 50_000, now, null)).resolves.toBeDefined();
  });

  it('carrera: dos devoluciones simultáneas (planes distintos) de 10 con tope 15 → una entra y la otra pasa del tope', async () => {
    const now = new Date(); // las filas nacen con el reloj real de la BD
    const results = await Promise.allSettled([
      createRefund(es, userC, 1_000, now, 1_500),
      createRefund(es, userC, 1_000, now, 1_500, true),
    ]);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(DailyRefundCapExceededError);
  });

  it('la comprobación espera al bloqueo consultivo de (sede, usuario, día) hasta el COMMIT del otro', async () => {
    const now = new Date('2026-11-09T15:00:00Z'); // 9 nov en Caracas
    const day = '2026-11-09';
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => (locked = resolve));
    // Otra «petición» ya tiene el bloqueo de ese usuario y día.
    const holder = raw.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(
          hashtext('dx462_refund_cap:' || ${ve.tenantId} || ':' || ${ve.locationId}),
          hashtext(${userC} || ':' || ${day})
        )`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await hasLock;
    let settled = false;
    const waiting = createRefund(ve, userC, 1_000, now, 1_500).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(settled).toBe(false);
    release();
    await holder;
    await expect(waiting).resolves.toBeDefined();
  });
});
