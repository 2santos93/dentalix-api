import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import {
  backfillPaymentAllocations,
  type BackfillDeps,
  type BackfillOptions,
} from '../src/modules/payments/application/backfill-payment-allocations';
import { PlanAllocationRebalancer } from '../src/modules/payments/application/plan-allocation-rebalancer';
import { GetPaymentAllocationsUseCase } from '../src/modules/payments/application/use-cases/get-payment-allocations.use-case';
import { GetPlanBalanceUseCase } from '../src/modules/payments/application/use-cases/get-plan-balance.use-case';
import { ReplacePaymentAllocationsUseCase } from '../src/modules/payments/application/use-cases/replace-payment-allocations.use-case';
import {
  PLAN_ALLOCATION_REPOSITORY,
  type PlanAllocationRepository,
} from '../src/modules/payments/domain/ports/plan-allocation-repository.port';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { seedDemo } from '../prisma/seed-demo';
import { purgeDemoTenants } from './support/demo-tenant-purge';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-051 R17: el backfill sobre el seed demo. Escribe y BORRA EN DURO: solo
// contra una base de test.
for (const key of ['DATABASE_URL', 'DIRECT_URL'] as const) {
  if (!process.env[key]?.includes('_test')) {
    throw new Error(
      `payment-allocations-backfill.int-spec: ${key} no apunta a una base de test (*_test*); aborto.`,
    );
  }
}

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const OTHER_SUBDOMAIN = 'dx051-backfill-other';
const PAID_AT = new Date('2026-10-20T12:00:00.000Z');
// Fechas de la tasa por si la sede no está en UTC.
const RATE_DATES = ['2026-10-19', '2026-10-20', '2026-10-21'];
const EUR_PER_USD = 0.9;
// DX-375 / V1: los abonos en bolívares de la demo congelan (y al quitarles la
// imputación, vuelven a calcular) la tasa MANUAL de su día que la propia demo
// siembra: no hace falta ninguna tasa en la caché ni salir a la red.

let app: INestApplication;
let deps: BackfillDeps;
let tenantContext: TenantContextService;
let demoId: string;
let other: { tenantId: string; planId: string; eurPaymentId: string };
let ratesCreatedAt: Date;

/** Como un entorno anterior a DX-051: sin bases, imputaciones, historial ni cola. */
async function stripToLegacy(tenantId: string): Promise<void> {
  const where = { tenantId };
  // Las imputaciones antes que el historial: borrarlas deja su movimiento.
  await raw.paymentAllocation.deleteMany({ where });
  await raw.paymentAllocationMovement.deleteMany({ where });
  await raw.paymentPlanAmount.deleteMany({ where });
  await raw.planAllocationRebalanceRequest.deleteMany({ where });
}

const run = (opts: BackfillOptions = {}) =>
  backfillPaymentAllocations(deps, { tenantId: demoId, ...opts });

async function onlyReport(opts: BackfillOptions = {}) {
  const reports = await run(opts);
  expect(reports).toHaveLength(1);
  return reports[0];
}

const livePlanPayments = (tenantId: string) =>
  raw.payment.count({
    where: {
      tenantId,
      deletedAt: null,
      treatmentPlanId: { not: null },
      plan: { deletedAt: null },
    },
  });

async function state(tenantId: string) {
  const [bases, allocations] = await Promise.all([
    raw.paymentPlanAmount.findMany({
      where: { tenantId },
      orderBy: { paymentId: 'asc' },
    }),
    raw.paymentAllocation.findMany({
      where: { tenantId },
      orderBy: [{ paymentId: 'asc' }, { treatmentPlanItemId: 'asc' }],
    }),
  ]);
  return {
    bases: bases.map((b) => [b.paymentId, Number(b.amount), b.manual]),
    allocations: allocations.map((a) => [
      a.paymentId,
      a.treatmentPlanItemId,
      Number(a.amount),
      a.source,
    ]),
  };
}

/** Σ items.paid + unallocated = paid y nada por encima de lo facturable. */
async function expectInvariants(tenantId: string): Promise<void> {
  const plans = await raw.treatmentPlan.findMany({
    where: { tenantId, deletedAt: null, payments: { some: {} } },
    select: { id: true },
  });
  expect(plans.length).toBeGreaterThan(0);
  const balance = app.get(GetPlanBalanceUseCase, { strict: false });
  for (const { id } of plans) {
    const result = await tenantContext.run(tenantId, () =>
      balance.executeWithItems(id),
    );
    const itemsPaid = result.items.reduce((sum, i) => sum + i.paid, 0);
    expect(itemsPaid + result.unallocated).toBeCloseTo(result.paid, 2);
    expect(result.unconvertedPaymentsCount).toBe(0);
    for (const item of result.items) {
      expect(item.paid).toBeLessThanOrEqual(item.billable);
    }
  }
}

async function seedOtherClinic(): Promise<typeof other> {
  const tenant = await raw.tenant.create({
    data: { name: OTHER_SUBDOMAIN, subdomain: OTHER_SUBDOMAIN },
  });
  const tenantId = tenant.id;
  const location = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, { tenantId, name: 'Sede' }),
  });
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: 'Heredada' },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId,
      code: 'dx051-backfill',
      kind: 'PROCEDURE',
      labelEs: 'Resina',
      color: '#123456',
    },
  });
  const plan = await raw.treatmentPlan.create({
    data: {
      tenantId,
      patientId: patient.id,
      currency: 'EUR',
      status: 'ACCEPTED',
    },
  });
  await raw.treatmentPlanItem.create({
    data: {
      tenantId,
      planId: plan.id,
      toothNumber: '11',
      catalogItemId: catalog.id,
      price: 100,
      status: 'DONE',
      completedAt: PAID_AT,
    },
  });
  const pay = (amount: number, currency: string) =>
    raw.payment.create({
      data: {
        tenantId,
        locationId: location.id,
        treatmentPlanId: plan.id,
        patientId: patient.id,
        amount,
        currency,
        paidAt: PAID_AT,
      },
    });
  const eur = await pay(60, 'EUR');
  await pay(1000, 'MXN');
  return { tenantId, planId: plan.id, eurPaymentId: eur.id };
}

async function purgeOtherClinic(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: OTHER_SUBDOMAIN },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.paymentAllocation.deleteMany({ where });
  await raw.paymentAllocationMovement.deleteMany({ where });
  await raw.paymentPlanAmount.deleteMany({ where });
  await raw.payment.deleteMany({ where });
  await raw.treatmentPlanItem.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.patientLedger.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.dentalCatalogItem.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({
    where: { id: { in: tenants.map((t) => t.id) } },
  });
}

describe('backfill de imputaciones de abonos (DX-051, R17)', () => {
  beforeAll(async () => {
    await purgeDemoTenants(raw);
    await purgeOtherClinic();
    ratesCreatedAt = new Date();
    // Una tasa USD→EUR y ninguna para MXN: «sin tasa» sin salir a la red.
    await raw.exchangeRateSnapshot.createMany({
      data: RATE_DATES.map((date) => ({
        date,
        currency: 'EUR',
        rate: EUR_PER_USD,
      })),
      skipDuplicates: true,
    });

    ({ tenantId: demoId } = await seedDemo({ quiet: true }));
    other = await seedOtherClinic();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    tenantContext = app.get(TenantContextService, { strict: false });
    deps = {
      repo: app.get<PlanAllocationRepository>(PLAN_ALLOCATION_REPOSITORY, {
        strict: false,
      }),
      rebalancer: app.get(PlanAllocationRebalancer, { strict: false }),
      convertAmount: app.get(ConvertAmountUseCase, { strict: false }),
      tenantContext,
    };
  }, 180000);

  beforeEach(async () => {
    await stripToLegacy(demoId);
    await stripToLegacy(other.tenantId);
  });

  afterAll(async () => {
    await app?.close();
    await purgeOtherClinic();
    await raw.exchangeRateSnapshot.deleteMany({
      where: {
        date: { in: RATE_DATES },
        currency: 'EUR',
        fetchedAt: { gte: ratesCreatedAt },
      },
    });
    await purgeDemoTenants(raw);
    await raw.$disconnect();
  });

  it('backfill allocates legacy payments with the automatic rule', async () => {
    const report = await onlyReport();

    expect(report.basesCreated).toBe(await livePlanPayments(demoId));
    expect(report.withoutRate).toBe(0);
    expect(report.plansRebalanced).toBeGreaterThan(0);
    expect(report.allocatedCents).toBeGreaterThan(0);
    expect(
      await raw.paymentAllocation.count({
        where: { tenantId: demoId, source: 'MANUAL' },
      }),
    ).toBe(0);
    expect(
      await raw.planAllocationRebalanceRequest.count({
        where: { tenantId: demoId },
      }),
    ).toBe(0);
    await expectInvariants(demoId);
  }, 120000);

  it('backfill is idempotent on the demo seed', async () => {
    await run();
    const before = await state(demoId);

    const again = await onlyReport();

    expect(again).toMatchObject({
      basesCreated: 0,
      withoutRate: 0,
      plansRebalanced: 0,
      allocatedCents: 0,
    });
    expect(await state(demoId)).toEqual(before);
    await expectInvariants(demoId);
  }, 120000);

  it('skips payments already allocated and keeps manual ones untouched', async () => {
    await run();
    // Un abono fijado a mano con sus líneas actuales; los demás abonos de su
    // plan pierden su imputación y su reparto vuelve a hacerse.
    const pinned = await raw.paymentAllocation.findFirstOrThrow({
      where: { tenantId: demoId },
      orderBy: { paymentId: 'asc' },
    });
    const view = await tenantContext.run(demoId, () =>
      app
        .get(GetPaymentAllocationsUseCase, { strict: false })
        .execute(pinned.paymentId),
    );
    const adminId = (
      await raw.clinicMembership.findFirstOrThrow({
        where: { tenantId: demoId, role: 'ADMIN' },
      })
    ).userId;
    await tenantContext.run(demoId, () =>
      app.get(ReplacePaymentAllocationsUseCase, { strict: false }).execute(
        pinned.paymentId,
        {
          mode: 'MANUAL',
          expectedVersion: view.version,
          allocations: view.allocations.map((l) => ({
            treatmentPlanItemId: l.treatmentPlanItemId,
            amount: l.amount,
          })),
        },
        adminId,
      ),
    );
    const manualBefore = await raw.paymentAllocation.findMany({
      where: { tenantId: demoId, paymentId: pinned.paymentId },
      orderBy: { treatmentPlanItemId: 'asc' },
    });
    await raw.paymentAllocation.deleteMany({
      where: {
        tenantId: demoId,
        treatmentPlanId: pinned.treatmentPlanId,
        paymentId: { not: pinned.paymentId },
      },
    });
    const bases = await raw.paymentPlanAmount.count({
      where: { tenantId: demoId },
    });

    const report = await onlyReport();

    expect(report.basesCreated).toBe(0);
    expect(
      await raw.paymentPlanAmount.count({ where: { tenantId: demoId } }),
    ).toBe(bases);
    expect(
      await raw.paymentAllocation.findMany({
        where: { tenantId: demoId, paymentId: pinned.paymentId },
        orderBy: { treatmentPlanItemId: 'asc' },
      }),
    ).toEqual(manualBefore);
    expect(
      (
        await raw.paymentPlanAmount.findUniqueOrThrow({
          where: { paymentId: pinned.paymentId },
        })
      ).manual,
    ).toBe(true);
    await expectInvariants(demoId);
  }, 120000);

  it('--tenant limits the run to one clinic', async () => {
    const [demoReport] = await run();
    expect(demoReport.tenantId).toBe(demoId);
    expect(
      await raw.paymentPlanAmount.count({
        where: { tenantId: other.tenantId },
      }),
    ).toBe(0);

    const [otherReport] = await run({ tenantId: other.tenantId });
    expect(otherReport.tenantId).toBe(other.tenantId);
    expect(otherReport.basesCreated).toBe(1);
    expect(
      await raw.paymentPlanAmount.count({
        where: { tenantId: other.tenantId },
      }),
    ).toBe(1);

    await expect(
      run({ tenantId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow('no existe');
  }, 120000);

  it('--dry-run writes nothing to allocations nor bases', async () => {
    const dry = await onlyReport({ dryRun: true });
    expect(dry.basesCreated).toBe(await livePlanPayments(demoId));
    expect(await state(demoId)).toEqual({ bases: [], allocations: [] });

    // Con las bases ya creadas, calcula el reparto y lo deshace.
    await run();
    const before = await state(demoId);
    await raw.paymentAllocation.deleteMany({ where: { tenantId: demoId } });
    const dryAllocation = await onlyReport({ dryRun: true });
    expect(dryAllocation.allocatedCents).toBeGreaterThan(0);
    expect(
      await raw.paymentAllocation.count({ where: { tenantId: demoId } }),
    ).toBe(0);

    const real = await onlyReport();
    expect(real.allocatedCents).toBe(dryAllocation.allocatedCents);
    expect(await state(demoId)).toEqual(before);
  }, 120000);

  it('payments without rate are counted, not fatal', async () => {
    const report = (await run({ tenantId: other.tenantId }))[0];

    // El abono en EUR (la moneda del plan) se convierte; el de MXN no tiene tasa.
    expect(report).toMatchObject({ basesCreated: 1, withoutRate: 1 });
    expect(
      await raw.paymentPlanAmount.findMany({
        where: { tenantId: other.tenantId },
        select: { paymentId: true },
      }),
    ).toEqual([{ paymentId: other.eurPaymentId }]);
    expect(report.allocatedCents).toBe(6_000);
  }, 120000);

  it('removes allocations an old replica left on a voided payment and re-spreads them', async () => {
    const { tenantId } = other;
    const clinic = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: other.planId },
      select: { patientId: true },
    });
    const location = await raw.location.findFirstOrThrow({
      where: { tenantId },
    });
    const catalog = await raw.dentalCatalogItem.findFirstOrThrow({
      where: { tenantId },
    });
    const plan = await raw.treatmentPlan.create({
      data: {
        tenantId,
        patientId: clinic.patientId,
        currency: 'EUR',
        status: 'ACCEPTED',
      },
    });
    const item = await raw.treatmentPlanItem.create({
      data: {
        tenantId,
        planId: plan.id,
        toothNumber: '12',
        catalogItemId: catalog.id,
        price: 100,
        status: 'DONE',
        completedAt: PAID_AT,
      },
    });
    const payWithBase = async (amount: number) => {
      const payment = await raw.payment.create({
        data: {
          tenantId,
          locationId: location.id,
          treatmentPlanId: plan.id,
          patientId: clinic.patientId,
          amount,
          currency: 'EUR',
          paidAt: PAID_AT,
        },
      });
      await raw.paymentPlanAmount.create({
        data: {
          paymentId: payment.id,
          tenantId,
          treatmentPlanId: plan.id,
          amount,
          currency: 'EUR',
          rateDate: PAID_AT,
        },
      });
      return payment.id;
    };
    try {
      const voided = await payWithBase(100);
      const live = await payWithBase(60);
      await raw.paymentAllocation.create({
        data: {
          tenantId,
          paymentId: voided,
          treatmentPlanId: plan.id,
          treatmentPlanItemId: item.id,
          amount: 100,
          source: 'AUTO',
        },
      });
      // Lo que hacía el código anterior: marcar el abono sin tocar sus imputaciones.
      await raw.payment.update({
        where: { id: voided },
        data: { deletedAt: new Date() },
      });

      const [report] = await run({ tenantId });

      expect(report.voidedCleaned).toBe(1);
      const rows = await raw.paymentAllocation.findMany({
        where: { tenantId, treatmentPlanId: plan.id },
      });
      expect(rows.map((r) => [r.paymentId, Number(r.amount)])).toEqual([
        [live, 60],
      ]);
      const voidMovements = await raw.paymentAllocationMovement.findMany({
        where: { tenantId, paymentId: voided },
        orderBy: { deltaCents: 'desc' },
      });
      // El alta (AUTO) y, al limpiar, la baja con la causa de la anulación.
      expect(voidMovements.map((m) => [m.cause, Number(m.deltaCents)])).toEqual(
        [
          ['AUTO', 10_000],
          ['VOID', -10_000],
        ],
      );

      const again = (await run({ tenantId }))[0];
      expect(again).toMatchObject({ voidedCleaned: 0, allocatedCents: 0 });
    } finally {
      await raw.paymentAllocation.deleteMany({ where: { tenantId } });
      await raw.paymentAllocationMovement.deleteMany({ where: { tenantId } });
      await raw.paymentPlanAmount.deleteMany({ where: { tenantId } });
      await raw.payment.deleteMany({
        where: { tenantId, treatmentPlanId: plan.id },
      });
      await raw.treatmentPlanItem.deleteMany({ where: { planId: plan.id } });
      await raw.planAllocationRebalanceRequest.deleteMany({
        where: { tenantId },
      });
      await raw.treatmentPlan.delete({ where: { id: plan.id } });
    }
  }, 120000);
});
