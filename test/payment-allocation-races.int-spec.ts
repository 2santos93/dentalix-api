import { BadRequestException } from '@nestjs/common';
import {
  ClinicRole,
  Prisma,
  PrismaClient,
  TreatmentPlanItemStatus,
} from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import { PrismaPlanAllocationRepository } from '../src/modules/payments/infrastructure/allocations/prisma-plan-allocation.repository';
import { PlanAllocationRebalancer } from '../src/modules/payments/application/plan-allocation-rebalancer';
import { PaymentAllocationJobs } from '../src/modules/payments/application/payment-allocation-jobs';
import { JobRegistry } from '../src/modules/jobs/application/job-registry';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import type { ItemChange } from '../src/modules/treatment-plans/domain/ports/treatment-plan-repository.port';
import type { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import {
  hasFixedPointViolation,
  itemBillableCents,
  type AllocatableItem,
  type Donor,
} from '../src/modules/payments/domain/allocation-rules';
import { isPlanBillable } from '../src/modules/treatment-plans/domain/plan-status-machine';
import {
  gate,
  settle,
  transactionId,
  waitForTransactionWaiters,
} from './support/postgres-concurrency';

// DX-051 Task 3, contra Postgres con conexiones reales (rol dentalix_app vía
// runWithTenant, RLS FORCE): el reparto automático (R5, R6, R9), el alta con
// base (R4), la anulación (R12, pre-flight C1) y el barrido (R9.3). Tras cada
// caso: punto fijo (ningún donante no fijado con sobrante mientras un ítem
// tenga libre) e invariantes de R7. `raw` (DIRECT_URL, superusuario) siembra,
// observa y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const paymentRepo = new PrismaPaymentRepository(prisma, tenantContext);
const allocationRepo = new PrismaPlanAllocationRepository(
  prisma,
  tenantContext,
);
const planRepo = new PrismaTreatmentPlanRepository(prisma, tenantContext);

/** Tasas del barrido (moneda del abono → del plan); sin entrada, «sin tasa». */
const rates: Record<string, number> = {};
const convert = {
  execute: (input: { amount: number; from: string; to: string }) => {
    const rate = input.from === input.to ? 1 : rates[input.from];
    if (rate === undefined) {
      return Promise.reject(
        new BadRequestException(`unsupported currency: ${input.from}`),
      );
    }
    return Promise.resolve({ ...input, result: 0, rateUsed: rate });
  },
} as unknown as ConvertAmountUseCase;
const rebalancer = new PlanAllocationRebalancer(allocationRepo, convert);
const jobs = new PaymentAllocationJobs(
  new JobRegistry(),
  rebalancer,
  allocationRepo,
  tenantContext,
);

const SUBDOMAINS = ['dx051-races-a', 'dx051-races-b'];
const DAY = new Date('2026-10-20T15:00:00.000Z');
const REPEAT = 20;
const DEADLOCK = '40P01';

interface Clinic {
  tenantId: string;
  locationId: string;
  patientId: string;
  catalogItemId: string;
  userId: string;
}

let a: Clinic;
let b: Clinic;
let seq = 0;

const inTenant = <T>(clinic: Clinic, fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(clinic.tenantId, undefined, fn);

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const location = await raw.location.create({
    data: { tenantId, name: 'Sede' },
  });
  const user = await raw.user.create({
    data: {
      email: `${subdomain}@example.com`,
      fullName: 'Admin',
      passwordHash: 'x',
    },
  });
  await raw.clinicMembership.create({
    data: { tenantId, userId: user.id, role: ClinicRole.ADMIN },
  });
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: 'Carrera' },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId,
      code: `dx051-${subdomain}`,
      kind: 'PROCEDURE',
      labelEs: 'Resina',
      color: '#123456',
    },
  });
  return {
    tenantId,
    locationId: location.id,
    patientId: patient.id,
    catalogItemId: catalog.id,
    userId: user.id,
  };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length > 0) {
    const where = { tenantId: { in: ids } };
    // Las imputaciones antes que el historial: borrarlas deja su movimiento.
    await raw.paymentAllocation.deleteMany({ where });
    await raw.paymentAllocationMovement.deleteMany({ where });
    await raw.paymentPlanAmount.deleteMany({ where });
    await raw.paymentReceipt.deleteMany({ where });
    await raw.payment.deleteMany({ where });
    await raw.treatmentPlanItem.deleteMany({ where });
    // La cola cae con sus planes (ON DELETE CASCADE).
    await raw.treatmentPlan.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.dentalCatalogItem.deleteMany({ where });
    await raw.clinicMembership.deleteMany({ where });
    await raw.paymentReceiptCounter.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  await raw.user.deleteMany({
    where: { email: { in: SUBDOMAINS.map((s) => `${s}@example.com`) } },
  });
}

async function plan(clinic: Clinic, currency = 'EUR'): Promise<string> {
  return (
    await raw.treatmentPlan.create({
      data: {
        tenantId: clinic.tenantId,
        patientId: clinic.patientId,
        currency,
        status: 'ACCEPTED',
      },
    })
  ).id;
}

async function item(
  clinic: Clinic,
  planId: string,
  price: number,
  status: 'PROPOSED' | 'ACCEPTED' | 'DONE',
): Promise<string> {
  return (
    await raw.treatmentPlanItem.create({
      data: {
        tenantId: clinic.tenantId,
        planId,
        toothNumber: String(11 + (seq++ % 20)),
        catalogItemId: clinic.catalogItemId,
        price,
        status,
        completedAt: status === 'DONE' ? DAY : null,
      },
    })
  ).id;
}

/** Abono sembrado en EUR con su base (salvo `base: false`), sin encolar. */
async function pay(
  clinic: Clinic,
  planId: string,
  amount: number,
  opts: { paidAt?: Date; base?: boolean; currency?: string } = {},
): Promise<string> {
  const payment = await raw.payment.create({
    data: {
      tenantId: clinic.tenantId,
      locationId: clinic.locationId,
      treatmentPlanId: planId,
      patientId: clinic.patientId,
      amount,
      currency: opts.currency ?? 'EUR',
      paidAt: opts.paidAt ?? DAY,
    },
  });
  if (opts.base !== false) {
    await raw.paymentPlanAmount.create({
      data: {
        paymentId: payment.id,
        tenantId: clinic.tenantId,
        treatmentPlanId: planId,
        amount,
        currency: 'EUR',
        rateDate: DAY,
      },
    });
  }
  return payment.id;
}

/** Abono por el repositorio (R4: base y encolado en su transacción). */
function record(
  clinic: Clinic,
  planId: string,
  amount: number,
  planAmount: number | null = amount,
) {
  return inTenant(clinic, () =>
    paymentRepo.create({
      treatmentPlanId: planId,
      patientId: clinic.patientId,
      amount,
      currency: 'EUR',
      paidAt: { civilDate: '2026-10-20' },
      createdById: clinic.userId,
      receiptPlanBalance: null,
      planAmount:
        planAmount === null
          ? null
          : { planCurrency: 'EUR', amount: planAmount, rateDate: '2026-10-20' },
    }),
  );
}

function drain(clinic: Clinic, preferPlanId?: string): Promise<number> {
  return inTenant(clinic, () =>
    rebalancer.drainPending({ actorId: clinic.userId, preferPlanId }),
  );
}

function updateItem(
  clinic: Clinic,
  itemId: string,
  patch: ItemChange['patch'],
) {
  return inTenant(clinic, () => planRepo.updateItem(itemId, () => ({ patch })));
}

function voidPayment(clinic: Clinic, paymentId: string) {
  return inTenant(clinic, () =>
    paymentRepo.softDelete(paymentId, {
      voidedById: clinic.userId,
      voidedByRole: ClinicRole.ADMIN,
      voidedAt: new Date(),
      reason: 'Prueba de carrera',
      request: null,
    }),
  );
}

const cents = (value: Prisma.Decimal | number): number =>
  Math.round(Number(value) * 100);

async function allocationCents(where: Prisma.PaymentAllocationWhereInput) {
  const rows = await raw.paymentAllocation.findMany({ where });
  return rows.reduce((sum, r) => sum + cents(r.amount), 0);
}

async function queued(planId: string): Promise<number> {
  return raw.planAllocationRebalanceRequest.count({
    where: { treatmentPlanId: planId },
  });
}

/**
 * Invariantes del plan leídas por fuera: R7 (Σ por ítem ≤ facturable, Σ por
 * abono ≤ base), ninguna imputación de un abono anulado, `Σ items.paid +
 * sin imputar = pagado` y el punto fijo. Devuelve lo imputado por ítem.
 */
async function assertInvariants(planId: string): Promise<Map<string, number>> {
  const thePlan = await raw.treatmentPlan.findUniqueOrThrow({
    where: { id: planId },
  });
  const planBillable = !thePlan.deletedAt && isPlanBillable(thePlan.status);
  const items = await raw.treatmentPlanItem.findMany({ where: { planId } });
  const bases = await raw.paymentPlanAmount.findMany({
    where: { treatmentPlanId: planId },
    include: {
      payment: { select: { deletedAt: true, paidAt: true, createdAt: true } },
    },
  });
  const allocations = await raw.paymentAllocation.findMany({
    where: { treatmentPlanId: planId },
  });
  const byItem = new Map<string, number>();
  const byPayment = new Map<string, number>();
  for (const row of allocations) {
    byItem.set(
      row.treatmentPlanItemId,
      (byItem.get(row.treatmentPlanItemId) ?? 0) + cents(row.amount),
    );
    byPayment.set(
      row.paymentId,
      (byPayment.get(row.paymentId) ?? 0) + cents(row.amount),
    );
  }

  const voided = new Set(
    bases.filter((b) => b.payment.deletedAt).map((b) => b.paymentId),
  );
  expect(allocations.filter((r) => voided.has(r.paymentId))).toEqual([]);

  const allocatable: AllocatableItem[] = [];
  for (const it of items) {
    const billableCents = itemBillableCents(
      {
        status: it.status,
        price: Number(it.price),
        discount: Number(it.discount),
        deletedAt: it.deletedAt,
      },
      planBillable,
    );
    expect(byItem.get(it.id) ?? 0).toBeLessThanOrEqual(billableCents);
    if (billableCents > 0) {
      allocatable.push({
        id: it.id,
        status:
          it.status === TreatmentPlanItemStatus.DONE ? 'DONE' : 'ACCEPTED',
        createdAt: it.createdAt,
        completedAt: it.completedAt,
        billableCents,
        allocatedCents: byItem.get(it.id) ?? 0,
      });
    }
  }

  const live = bases.filter((b) => !b.payment.deletedAt);
  let surplus = 0;
  const donors: Donor[] = [];
  for (const base of live) {
    const used = byPayment.get(base.paymentId) ?? 0;
    expect(used).toBeLessThanOrEqual(cents(base.amount));
    surplus += cents(base.amount) - used;
    if (!base.manual) {
      donors.push({
        paymentId: base.paymentId,
        paidAt: base.payment.paidAt,
        createdAt: base.payment.createdAt,
        baseCents: cents(base.amount),
        allocatedCents: used,
      });
    }
  }
  const allocated = allocations.reduce((sum, r) => sum + cents(r.amount), 0);
  const paid = live.reduce((sum, base) => sum + cents(base.amount), 0);
  expect(allocated + surplus).toBe(paid);
  expect(hasFixedPointViolation(donors, allocatable)).toBe(false);
  return byItem;
}

/** Una pausa dentro de una transacción: `reached` al llegar, sigue con `release`. */
interface Stop {
  reached: ReturnType<typeof gate<string>>;
  release: ReturnType<typeof gate<void>>;
}
const stop = (): Stop => ({ reached: gate<string>(), release: gate<void>() });

/**
 * La PRÓXIMA transacción de `runWithTenant` se para antes de las llamadas
 * `modelo.método` indicadas (señala su XID y espera a `release`). Así un test
 * deja una transacción abierta exactamente entre dos sentencias suyas.
 */
function pauseNextTransaction(stops: Record<string, Stop>): void {
  const original = prisma.runWithTenant.bind(prisma) as (
    fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => Promise<unknown>;
  jest.spyOn(prisma, 'runWithTenant').mockImplementationOnce(((
    fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) =>
    original((tx) =>
      fn(
        new Proxy(tx, {
          get(target, model) {
            const delegate: unknown = Reflect.get(target, model);
            if (typeof model !== 'string' || typeof delegate !== 'object') {
              return delegate;
            }
            return new Proxy(delegate as object, {
              get(d, method) {
                const call: unknown = Reflect.get(d, method);
                const at = stops[`${model}.${String(method)}`];
                if (!at || typeof call !== 'function') return call;
                return async (...args: unknown[]) => {
                  at.reached.open(await transactionId(target));
                  await at.release.wait;
                  return (call as (...a: unknown[]) => unknown).apply(d, args);
                };
              },
            });
          },
        }),
      ),
    )) as never);
}

beforeAll(async () => {
  await cleanup();
  a = await seedClinic(SUBDOMAINS[0]);
  b = await seedClinic(SUBDOMAINS[1]);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await raw.$disconnect();
});

describe('DX-051 · reparto automático con conexiones reales (int)', () => {
  it('two concurrent payments never over-allocate the same item', async () => {
    const planId = await plan(a);
    const done = await item(a, planId, 100, 'DONE');

    await Promise.all([record(a, planId, 80), record(a, planId, 80)]);
    await Promise.all([drain(a, planId), drain(a, planId)]);

    const byItem = await assertInvariants(planId);
    expect(byItem.get(done)).toBe(10_000);
    expect(await allocationCents({ treatmentPlanId: planId })).toBe(10_000);
    // Sin imputar: 160 − 100.
    const bases = await raw.paymentPlanAmount.findMany({
      where: { treatmentPlanId: planId },
    });
    expect(bases.reduce((s, x) => s + cents(x.amount), 0) - 10_000).toBe(6_000);
    expect(await queued(planId)).toBe(0);
  });

  it('void racing rebalance never leaves allocations on a voided payment', async () => {
    for (let round = 0; round < REPEAT; round += 1) {
      const planId = await plan(a);
      await item(a, planId, 100, 'DONE');
      await item(a, planId, 50, 'ACCEPTED');
      await pay(a, planId, 30, { paidAt: new Date('2026-10-01T15:00:00Z') });
      const voided = await pay(a, planId, 120);

      const [voidOutcome, rebalanceOutcome] = await Promise.all([
        settle(voidPayment(a, voided)),
        settle(inTenant(a, () => rebalancer.rebalancePlan(planId, null))),
      ]);
      expect(voidOutcome).toEqual({ status: 'fulfilled', value: true });
      expect(rebalanceOutcome.status).toBe('fulfilled');

      expect(
        await raw.paymentAllocation.count({ where: { paymentId: voided } }),
      ).toBe(0);
      // La anulación encoló el plan: lo liberado lo llena el otro abono.
      await drain(a, planId);
      await assertInvariants(planId);
      expect(await queued(planId)).toBe(0);
    }
  });

  it('void and a concurrent edit of an item it covers never deadlock', async () => {
    for (let round = 0; round < REPEAT; round += 1) {
      const planId = await plan(a);
      const itemA = await item(a, planId, 100, 'DONE');
      const itemB = await item(a, planId, 100, 'ACCEPTED');
      await pay(a, planId, 50, { paidAt: new Date('2026-10-01T15:00:00Z') });
      const voided = await pay(a, planId, 120);
      await drain(a, planId);
      expect(
        await allocationCents({
          paymentId: voided,
          treatmentPlanItemId: itemA,
        }),
      ).toBeGreaterThan(0);

      // La edición libera filas del ítem (descuento) mientras la anulación
      // borra las del abono en ese mismo ítem: el historial de ambas toma el
      // ítem FOR KEY SHARE.
      const outcomes = await Promise.all([
        settle(voidPayment(a, voided)),
        settle(updateItem(a, itemA, { discount: 40 })),
        settle(updateItem(a, itemB, { discount: 10 })),
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect((outcome.reason as { code?: string }).code).not.toBe(DEADLOCK);
          throw outcome.reason;
        }
      }
      expect(
        await raw.paymentAllocation.count({ where: { paymentId: voided } }),
      ).toBe(0);
      await drain(a, planId);
      await assertInvariants(planId);
    }
  });

  it('a void in flight never lets a sweep-created base be allocated (deterministic)', async () => {
    const planId = await plan(a);
    const done = await item(a, planId, 100, 'DONE');
    const voided = await pay(a, planId, 100, { currency: 'USD', base: false });
    // La anulación se para antes de anular y antes de su última sentencia.
    const beforeUpdate = stop();
    const beforeCommit = stop();
    pauseNextTransaction({
      'payment.updateMany': beforeUpdate,
      'paymentReceipt.updateMany': beforeCommit,
    });
    const voiding = settle(voidPayment(a, voided));
    const voidXid = await beforeUpdate.reached.wait;

    // El barrido intenta crear la base con la anulación ya en marcha.
    const ensuring = settle(
      inTenant(a, () =>
        allocationRepo.ensureBase(voided, 90, 'EUR', '2026-10-20'),
      ),
    );
    const first = await Promise.race([
      ensuring.then(() => 'base' as const),
      waitForTransactionWaiters(raw, voidXid).then(
        () => 'waiting' as const,
        () => 'base' as const,
      ),
    ]);
    if (first === 'base') {
      // Sin el bloqueo de la fila del abono: la base nace y un reparto lee el
      // abono vivo, se para antes de imputar y termina tras el DELETE vacío.
      const beforeInsert = stop();
      pauseNextTransaction({ 'paymentAllocation.create': beforeInsert });
      const spreading = settle(
        inTenant(a, () => rebalancer.rebalancePlan(planId, null)),
      );
      await beforeInsert.reached.wait;
      beforeUpdate.release.open();
      await beforeCommit.reached.wait;
      beforeInsert.release.open();
      await spreading;
    }
    beforeUpdate.release.open();
    beforeCommit.release.open();

    expect(await voiding).toEqual({ status: 'fulfilled', value: true });
    // Lo que importa: nada imputado de un abono anulado.
    expect(
      await raw.paymentAllocation.count({ where: { paymentId: voided } }),
    ).toBe(0);
    expect(await allocationCents({ treatmentPlanItemId: done })).toBe(0);
    // Y por qué: la base no llega a nacer (el barrido vio el abono anulado).
    expect(await ensuring).toEqual({ status: 'fulfilled', value: false });
    expect(
      await raw.paymentPlanAmount.count({ where: { paymentId: voided } }),
    ).toBe(0);
    jest.restoreAllMocks();
  });

  it('void racing a sweep-created base, a drain and an item edit never deadlocks', async () => {
    rates.USD = 0.9;
    try {
      for (let round = 0; round < REPEAT; round += 1) {
        const planId = await plan(a);
        const itemA = await item(a, planId, 100, 'DONE');
        await item(a, planId, 100, 'ACCEPTED');
        await pay(a, planId, 50, { paidAt: new Date('2026-10-01T15:00:00Z') });
        // Cobrado sin tasa: el barrido le crea la base mientras se anula.
        const voided = await pay(a, planId, 100, {
          currency: 'USD',
          base: false,
        });

        const outcomes = await Promise.all([
          settle(inTenant(a, () => rebalancer.createMissingBases(50))),
          settle(drain(a, planId)),
          settle(voidPayment(a, voided)),
          settle(updateItem(a, itemA, { discount: 10 })),
        ]);
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            expect((outcome.reason as { code?: string }).code).not.toBe(
              DEADLOCK,
            );
            throw outcome.reason;
          }
        }
        expect(outcomes[2]).toEqual({ status: 'fulfilled', value: true });
        expect(
          await raw.paymentAllocation.count({ where: { paymentId: voided } }),
        ).toBe(0);
        await drain(a, planId);
        await assertInvariants(planId);
        expect(await queued(planId)).toBe(0);
      }
    } finally {
      delete rates.USD;
    }
  });

  it('dryRun computes against Postgres and leaves no trace', async () => {
    const planId = await plan(a);
    await item(a, planId, 100, 'DONE');
    await item(a, planId, 50, 'ACCEPTED');
    await pay(a, planId, 120);
    const before = {
      allocations: await raw.paymentAllocation.count({
        where: { treatmentPlanId: planId },
      }),
      movements: await raw.paymentAllocationMovement.count({
        where: { treatmentPlanId: planId },
      }),
      queued: await queued(planId),
    };
    expect(before.queued).toBeGreaterThan(0);

    const result = await inTenant(a, () =>
      rebalancer.rebalancePlan(planId, null, { dryRun: true }),
    );

    expect(result).toEqual({ allocatedCents: 12_000 });
    expect({
      allocations: await raw.paymentAllocation.count({
        where: { treatmentPlanId: planId },
      }),
      movements: await raw.paymentAllocationMovement.count({
        where: { treatmentPlanId: planId },
      }),
      queued: await queued(planId),
    }).toEqual(before);
    // El reparto de verdad imputa lo mismo que anunció el dry-run.
    expect(
      await inTenant(a, () => rebalancer.rebalancePlan(planId, null)),
    ).toEqual(result);
  });

  it('rebalance and concurrent edits of different items never deadlock', async () => {
    for (let round = 0; round < REPEAT; round += 1) {
      const planId = await plan(a);
      const itemA = await item(a, planId, 100, 'DONE');
      const itemB = await item(a, planId, 100, 'ACCEPTED');
      await pay(a, planId, 80, { paidAt: new Date('2026-10-01T15:00:00Z') });
      await pay(a, planId, 80);
      await inTenant(a, () => rebalancer.rebalancePlan(planId, null));

      const outcomes = await Promise.all([
        settle(inTenant(a, () => rebalancer.rebalancePlan(planId, null))),
        settle(updateItem(a, itemA, { discount: 30 })),
        settle(updateItem(a, itemB, { price: 140 })),
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect((outcome.reason as { code?: string }).code).not.toBe(DEADLOCK);
          throw outcome.reason;
        }
      }
      await drain(a, planId);
      await assertInvariants(planId);
      expect(await queued(planId)).toBe(0);
    }
  });

  it('after concurrent PROPOSED→ACCEPTED and a drain, no unpinned donor has surplus while an item has free balance', async () => {
    for (let round = 0; round < REPEAT; round += 1) {
      const planId = await plan(a);
      await item(a, planId, 100, 'DONE');
      const proposed = await item(a, planId, 50, 'PROPOSED');
      await pay(a, planId, 150);
      // La inserción de los ítems ya dejó solicitudes en la cola.
      expect(await queued(planId)).toBeGreaterThan(0);

      const [accept, drained] = await Promise.all([
        settle(updateItem(a, proposed, { status: 'ACCEPTED' })),
        settle(drain(a, planId)),
      ]);
      expect(accept.status).toBe('fulfilled');
      expect(drained.status).toBe('fulfilled');
      // El drenado de la petición que aceptó el ítem (como el interceptor).
      await drain(a, planId);

      const byItem = await assertInvariants(planId);
      expect(byItem.get(proposed)).toBe(5_000);
      expect(await queued(planId)).toBe(0);
    }
  });

  it('release then respread is oldest-first and keeps totals', async () => {
    const planId = await plan(a);
    const itemA = await item(a, planId, 100, 'DONE');
    const itemB = await item(a, planId, 100, 'ACCEPTED');
    const older = await pay(a, planId, 80, {
      paidAt: new Date('2026-10-01T15:00:00Z'),
    });
    const newer = await pay(a, planId, 80);
    await drain(a, planId);
    expect(
      await allocationCents({ paymentId: older, treatmentPlanItemId: itemA }),
    ).toBe(8_000);
    expect(
      await allocationCents({ paymentId: newer, treatmentPlanItemId: itemA }),
    ).toBe(2_000);
    expect(
      await allocationCents({ paymentId: newer, treatmentPlanItemId: itemB }),
    ).toBe(6_000);

    // Descuento de 50 en A: se recorta lo más reciente (los 20 del nuevo) y
    // luego 30 del antiguo; el reparto llena B con el más antiguo primero.
    await updateItem(a, itemA, { discount: 50 });
    expect(await queued(planId)).toBeGreaterThan(0);
    await drain(a, planId);

    expect(
      await allocationCents({ paymentId: older, treatmentPlanItemId: itemA }),
    ).toBe(5_000);
    expect(
      await allocationCents({ paymentId: newer, treatmentPlanItemId: itemA }),
    ).toBe(0);
    expect(
      await allocationCents({ paymentId: older, treatmentPlanItemId: itemB }),
    ).toBe(3_000);
    expect(
      await allocationCents({ paymentId: newer, treatmentPlanItemId: itemB }),
    ).toBe(7_000);
    await assertInvariants(planId);
    // Historial: lo vivo es la suma de los movimientos de cada par.
    const movements = await raw.paymentAllocationMovement.groupBy({
      by: ['paymentId', 'treatmentPlanItemId'],
      where: { treatmentPlanId: planId },
      _sum: { deltaCents: true },
    });
    expect(
      movements.reduce((s, m) => s + Number(m._sum.deltaCents ?? 0), 0),
    ).toBe(await allocationCents({ treatmentPlanId: planId }));
  });

  it('marking an item DONE pulls surplus from earlier payments', async () => {
    const planId = await plan(a);
    await item(a, planId, 50, 'DONE');
    const later = await item(a, planId, 100, 'PROPOSED');
    const earlier = await pay(a, planId, 120, {
      paidAt: new Date('2026-10-01T15:00:00Z'),
    });
    await drain(a, planId);
    expect(await allocationCents({ paymentId: earlier })).toBe(5_000);

    await updateItem(a, later, { status: 'DONE' });
    await drain(a, planId);

    expect(
      await allocationCents({ paymentId: earlier, treatmentPlanItemId: later }),
    ).toBe(7_000);
    await assertInvariants(planId);
  });

  describe('barrido', () => {
    const mine = () => [a.tenantId, b.tenantId];

    beforeEach(() => {
      // Solo las clínicas de esta suite: la BD de test es compartida. La
      // consulta real de clínicas sigue corriendo.
      const all = new PrismaPlanAllocationRepository(prisma, tenantContext);
      jest
        .spyOn(allocationRepo, 'tenantIds')
        .mockImplementation(async () =>
          (await all.tenantIds()).filter((id) => mine().includes(id)),
        );
    });

    afterEach(() => {
      jest.restoreAllMocks();
      delete rates.USD;
    });

    it('sweep creates the base once a rate appears and allocates', async () => {
      const planId = await plan(a);
      const done = await item(a, planId, 100, 'DONE');
      // Cobrado en USD durante la caída del proveedor: sin base.
      const payment = await inTenant(a, () =>
        paymentRepo.create({
          treatmentPlanId: planId,
          patientId: a.patientId,
          amount: 100,
          currency: 'USD',
          paidAt: { civilDate: '2026-10-20' },
          createdById: a.userId,
          receiptPlanBalance: null,
          planAmount: null,
        }),
      );

      await jobs.sweep();
      expect(
        await raw.paymentPlanAmount.count({ where: { paymentId: payment.id } }),
      ).toBe(0);

      rates.USD = 0.9;
      await jobs.sweep();

      const base = await raw.paymentPlanAmount.findUniqueOrThrow({
        where: { paymentId: payment.id },
      });
      expect(Number(base.amount)).toBe(90);
      expect(base.currency).toBe('EUR');
      expect(base.rateDate.toISOString().slice(0, 10)).toBe('2026-10-20');
      expect(
        await allocationCents({
          paymentId: payment.id,
          treatmentPlanItemId: done,
        }),
      ).toBe(9_000);
      // El barrido imputa sin autor.
      const rows = await raw.paymentAllocation.findMany({
        where: { paymentId: payment.id },
      });
      expect(rows.map((r) => [r.source, r.createdById])).toEqual([
        ['AUTO', null],
      ]);
      await assertInvariants(planId);
      expect(await queued(planId)).toBe(0);
    });

    it('sweep drains requests of every tenant', async () => {
      const plans: [Clinic, string][] = [];
      for (const clinic of [a, b]) {
        const planId = await plan(clinic);
        await item(clinic, planId, 100, 'DONE');
        await pay(clinic, planId, 60);
        plans.push([clinic, planId]);
      }

      await jobs.sweep();

      for (const [, planId] of plans) {
        expect(await queued(planId)).toBe(0);
        expect(await allocationCents({ treatmentPlanId: planId })).toBe(6_000);
        await assertInvariants(planId);
      }
    });

    it('requests of a retired plan are deleted, not retried', async () => {
      const planId = await plan(a);
      const done = await item(a, planId, 100, 'DONE');
      await pay(a, planId, 60);
      // Retirado «por detrás»: el trigger del plan libera y encola.
      await raw.treatmentPlan.update({
        where: { id: planId },
        data: { deletedAt: new Date() },
      });
      expect(await queued(planId)).toBeGreaterThan(0);

      await jobs.sweep();

      expect(await queued(planId)).toBe(0);
      expect(await allocationCents({ treatmentPlanItemId: done })).toBe(0);
    });
  });
});
