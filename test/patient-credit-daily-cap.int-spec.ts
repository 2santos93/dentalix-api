import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientCreditRepository } from '../src/modules/patient-credit/infrastructure/prisma-patient-credit.repository';
import {
  DailyRefundCapExceededError,
  dailyRefundWindow,
} from '../src/modules/patient-credit/domain/patient-credit';
import { lockDailyRefundCap } from '../src/modules/patient-credit/infrastructure/daily-refund-cap-lock';
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
  idempotencyKey?: string,
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
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(capCents === null
        ? {}
        : { dailyCap: { capCents, clock: () => now } }),
    }),
  );
}

/**
 * El `createdAt` lo fija un trigger del servidor (DX-226): para situar la
 * devolución en el día del reloj inyectado se reescribe como superusuario
 * (tabla append-only: se salta el trigger con session_replication_role).
 */
async function refund(
  s: Seeded,
  userId: string,
  amountCents: number,
  now: Date,
  capCents: number | null = CAP,
) {
  const created = await createRefund(s, userId, amountCents, now, capCents);
  await raw.$transaction([
    raw.$executeRaw`SET LOCAL session_replication_role = replica`,
    raw.$executeRaw`UPDATE "patient_credit_refunds" SET "createdAt" = ${now} WHERE "id" = ${created.id}::uuid`,
  ]);
  return created;
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

  it('humo: dos devoluciones simultáneas (planes distintos) de 10 con tope 15', async () => {
    const now = new Date();
    const results = await Promise.allSettled([
      createRefund(es, userC, 1_000, now, 1_500),
      createRefund(es, userC, 1_000, now, 1_500, true),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(DailyRefundCapExceededError);
  });

  it('A5: la comprobación espera al bloqueo de (sede, usuario, día) hasta el COMMIT del otro', async () => {
    const now = new Date('2026-11-09T15:00:00Z'); // 9 nov en Caracas
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => (locked = resolve));
    // Otra «petición» ya tiene el bloqueo (la MISMA función que usa producción).
    const holder = raw.$transaction(
      async (tx) => {
        await lockDailyRefundCap(tx, {
          tenantId: ve.tenantId,
          locationId: ve.locationId,
          userId: userC,
          day: dailyRefundWindow(now, 'America/Caracas').day,
        });
        locked();
        await held;
      },
      { timeout: 30_000 },
    );
    await hasLock;
    let settled = false;
    const waiting = refund(ve, userC, 1_000, now, 1_500).finally(() => {
      settled = true;
    });
    // Espera determinista: hasta que Postgres muestra un bloqueo consultivo SIN
    // conceder en esta BD (la devolución esperando), o falla si acaba antes.
    let waiter = false;
    for (let i = 0; i < 300 && !settled && !waiter; i++) {
      const [{ n }] = await raw.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
      waiter = n > 0;
      if (!waiter) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    release();
    await holder;
    await waiting;
    expect(waiter).toBe(true);
  });

  it('A5: un reintento con la misma Idempotency-Key en vuelo devuelve la devolución original, no 403', async () => {
    // Día propio y fijo: con `new Date()`, el 9 nov sumaba sobre la devolución
    // del test anterior (misma sede, usuario y día) y pasaba el tope.
    const now = new Date('2026-11-12T15:00:00Z');
    const key = randomUUID();
    // Tope 15, importe 10: la réplica sumaría 20 y daría 403 si no se reconoce.
    const results = await Promise.all([
      createRefund(ve, userC, 1_000, now, 1_500, false, key),
      createRefund(ve, userC, 1_000, now, 1_500, false, key),
    ]);
    expect(results[1].id).toBe(results[0].id);
    const count = await raw.patientCreditRefund.count({
      where: { tenantId: ve.tenantId, idempotencyKey: key },
    });
    expect(count).toBe(1);
  });
});
