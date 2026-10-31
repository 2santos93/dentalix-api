import { Prisma, PrismaClient } from '@prisma/client';
import { prismaRuleCode } from '../src/shared/prisma/prisma-exception.filter';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientCreditRepository } from '../src/modules/patient-credit/infrastructure/prisma-patient-credit.repository';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-253, capa BD: los traspasos, las devoluciones, sus abonos de referencia y
// sus asientos son append-only (sin UPDATE ni DELETE para la app), con RLS
// FORCE y FK compuestas por tenant; y dos devoluciones simultáneas sobre el
// mismo saldo se ordenan con el bloqueo del plan: una entra y la otra es 409.
// `raw` (DIRECT_URL, superusuario) siembra y limpia; lo que se prueba va como
// dentalix_app (runWithTenant, bajo RLS).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repository = new PrismaPatientCreditRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx253-int-a', 'dx253-int-b'];
const EMAIL = 'dx253-int@example.com';

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  cancelledPlan: string;
  livePlan: string;
  paymentId: string;
}

let a: Seeded;
let b: Seeded;
let userId: string;

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length > 0) {
    const where = { tenantId: { in: ids } };
    // Superusuario: el trigger append-only deja la purga administrativa.
    await raw.patientCreditEntry.deleteMany({ where });
    await raw.patientCreditRefundPayment.deleteMany({ where });
    await raw.patientCreditRefund.deleteMany({ where });
    await raw.patientCreditTransfer.deleteMany({ where });
    await raw.patientCreditRefundCounter.deleteMany({ where });
    await raw.paymentReceipt.deleteMany({ where });
    await raw.payment.deleteMany({ where });
    await raw.treatmentPlan.deleteMany({ where });
    await raw.patientLedger.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  await raw.user.deleteMany({ where: { email: EMAIL } });
}

async function seed(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede',
      country: 'CO',
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
  const cancelled = await raw.treatmentPlan.create({
    data: {
      tenantId: tenant.id,
      patientId: patient.id,
      currency: 'COP',
      status: 'ACCEPTED',
    },
  });
  const live = await raw.treatmentPlan.create({
    data: {
      tenantId: tenant.id,
      patientId: patient.id,
      currency: 'COP',
      status: 'ACCEPTED',
    },
  });
  const payment = await raw.payment.create({
    data: {
      tenantId: tenant.id,
      locationId: location.id,
      treatmentPlanId: cancelled.id,
      patientId: patient.id,
      amount: 300_000,
      currency: 'COP',
      paidAt: new Date(),
      method: 'CASH',
    },
  });
  await raw.treatmentPlan.update({
    where: { id: cancelled.id },
    data: { status: 'CANCELLED' },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: patient.id,
    cancelledPlan: cancelled.id,
    livePlan: live.id,
    paymentId: payment.id,
  };
}

function asApp<T>(
  seeded: Seeded,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.runWithTenant(seeded.tenantId, fn);
}

async function sqlState(
  promise: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return prismaRuleCode(error);
  }
  throw new Error('la BD aceptó la escritura');
}

function inContext<T>(seeded: Seeded, fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(seeded.tenantId, seeded.locationId, fn);
}

describe('DX-253 · saldo a favor en la BD (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    userId = (
      await raw.user.create({
        data: { email: EMAIL, fullName: 'Admin', passwordHash: 'x' },
      })
    ).id;
    a = await seed(SUBDOMAINS[0]);
    b = await seed(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await raw.$disconnect();
  });

  it('las cinco tablas tienen RLS FORCE', async () => {
    const rows = await raw.$queryRaw<
      {
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }[]
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname LIKE 'patient_credit_%' AND relkind = 'r'
       ORDER BY relname`;
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    }
  });

  it('traspaso: dos asientos enlazados; la app no los actualiza ni los borra', async () => {
    const transfer = await inContext(a, () =>
      repository.createTransfer({
        sourcePlanId: a.cancelledPlan,
        targetPlanId: a.livePlan,
        amountCents: 20_000_000,
        currency: 'COP',
        reason: null,
        userId,
        fingerprint: 'f',
      }),
    );
    const entries = await raw.patientCreditEntry.findMany({
      where: { transferId: transfer.id },
      orderBy: { kind: 'asc' },
    });
    expect(
      entries.map((e) => [e.kind, e.treatmentPlanId, e.amount.toNumber()]),
    ).toEqual([
      ['TRANSFER_OUT', a.cancelledPlan, -200_000],
      ['TRANSFER_IN', a.livePlan, 200_000],
    ]);
    const credit = await inContext(a, () =>
      repository.readPlanCredit(a.cancelledPlan),
    );
    expect(credit?.creditCents).toBe(10_000_000);

    expect(
      await sqlState(
        asApp(a, (tx) =>
          tx.patientCreditEntry.update({
            where: { id: entries[0].id },
            data: { amount: -1 },
          }),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        asApp(
          a,
          (tx) =>
            tx.$executeRaw`DELETE FROM "patient_credit_transfers" WHERE "id" = ${transfer.id}::uuid`,
        ),
      ),
    ).toBe('42501');
    // Ni siquiera el superusuario lo actualiza (solo la purga borra).
    await expect(
      raw.patientCreditTransfer.update({
        where: { id: transfer.id },
        data: { reason: 'cambiado' },
      }),
    ).rejects.toThrow(/registro contable/);
  });

  it('RLS: otra clínica no ve ni escribe los asientos de A', async () => {
    const seen = await asApp(b, (tx) =>
      tx.patientCreditEntry.count({ where: { tenantId: a.tenantId } }),
    );
    expect(seen).toBe(0);
    expect(
      await sqlState(
        asApp(b, (tx) =>
          tx.patientCreditEntry.create({
            data: {
              tenantId: a.tenantId,
              patientId: a.patientId,
              treatmentPlanId: a.livePlan,
              currency: 'COP',
              amount: 1,
              kind: 'TRANSFER_IN',
              transferId: a.cancelledPlan,
            },
          }),
        ),
      ),
    ).toBe('42501');
  });

  it('FK compuestas: plan de otra clínica u otro paciente, abono de otro plan', async () => {
    // Plan de B con el tenant de A.
    expect(
      await sqlState(
        asApp(a, (tx) =>
          tx.patientCreditTransfer.create({
            data: {
              tenantId: a.tenantId,
              locationId: a.locationId,
              patientId: a.patientId,
              sourcePlanId: a.cancelledPlan,
              targetPlanId: b.livePlan,
              currency: 'COP',
              amount: 1,
              createdById: userId,
            },
          }),
        ),
      ),
    ).toBe('23503');
    // Sede de B.
    expect(
      await sqlState(
        asApp(a, (tx) =>
          tx.patientCreditTransfer.create({
            data: {
              tenantId: a.tenantId,
              locationId: b.locationId,
              patientId: a.patientId,
              sourcePlanId: a.cancelledPlan,
              targetPlanId: a.livePlan,
              currency: 'COP',
              amount: 1,
              createdById: userId,
            },
          }),
        ),
      ),
    ).toBe('23503');
    // Una devolución con caja es en efectivo (CHECK).
    expect(
      await sqlState(
        asApp(a, (tx) =>
          tx.patientCreditRefund.create({
            data: {
              tenantId: a.tenantId,
              locationId: a.locationId,
              patientId: a.patientId,
              treatmentPlanId: a.cancelledPlan,
              currency: 'COP',
              amount: 1,
              method: 'CARD',
              reason: 'Motivo',
              cashSessionId: a.cancelledPlan,
              seriesPrefix: 'DEV-X',
              number: 1,
              snapshot: {},
              createdById: userId,
            },
          }),
        ),
      ),
    ).toBe('23514');
  });

  it('carrera: dos devoluciones de 60.000 sobre 100.000 a favor → una entra y la otra es 409', async () => {
    const refund = () =>
      inContext(a, () =>
        repository.createRefund({
          planId: a.cancelledPlan,
          amountCents: 6_000_000,
          currency: 'COP',
          method: 'TRANSFER',
          reason: 'Devolución pedida',
          paymentIds: [a.paymentId],
          userId,
          fingerprint: 'f',
        }),
      );
    const results = await Promise.allSettled([refund(), refund()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { getStatus(): number }).getStatus()).toBe(
      409,
    );
    const credit = await inContext(a, () =>
      repository.readPlanCredit(a.cancelledPlan),
    );
    expect(credit?.creditCents).toBe(4_000_000);
    // El contador no deja hueco por la que no entró.
    const counter = await raw.patientCreditRefundCounter.findFirstOrThrow({
      where: { tenantId: a.tenantId },
    });
    expect(counter.lastNumber).toBe(1);
  });

  it('cartera: el resumen patient_ledgers suma los asientos al abonado del plan', async () => {
    const ledger = await raw.patientLedger.findFirstOrThrow({
      where: { tenantId: a.tenantId, patientId: a.patientId },
      select: { ledger: true },
    });
    const plans = (ledger.ledger as { plans: unknown[][] }).plans;
    const own = (planId: string) =>
      plans.find((p) => p[0] === planId)?.[6] ?? null;
    // Cancelado: 300.000 − 200.000 traspasados − 60.000 devueltos.
    expect(own(a.cancelledPlan)).toBe(40_000);
    expect(own(a.livePlan)).toBe(200_000);
  });
});
