import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPlanAllocationRepository } from '../src/modules/payments/infrastructure/allocations/prisma-plan-allocation.repository';
import { PlanAllocationRebalancer } from '../src/modules/payments/application/plan-allocation-rebalancer';
import type { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import {
  gate,
  settle,
  transactionId,
  waitForTransactionWaiters,
} from './support/postgres-concurrency';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-399-bis, capa DB: la imputación automática (DX-051) no reparte lo que el
// saldo a favor ya devolvió o traspasó (`credit-netting`, DX-399/DX-253).
// Secuencia del ticket: paga 130 en un plan de 100, se devuelven 30, se acepta
// un ítem de 30 -> el abono antiguo NO lo cubre; el abono nuevo de 30 sí.
// `raw` (DIRECT_URL, superusuario) siembra y observa; el reparto va por la app.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const allocationRepo = new PrismaPlanAllocationRepository(
  prisma,
  tenantContext,
);
const convert = {
  execute: () => Promise.reject(new BadRequestException('sin tasa')),
  memoized: () => convert,
} as unknown as ConvertAmountUseCase;
const rebalancer = new PlanAllocationRebalancer(allocationRepo, convert);

const SUBDOMAIN = 'dx399bis-int';
const T0 = new Date('2026-10-20T15:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const DAY = new Date('2026-10-20T00:00:00.000Z');

let tenantId: string;
let locationId: string;
let patientId: string;
let catalogItemId: string;
let seq = 0;

const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(tenantId, undefined, fn);

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = { tenantId: { in: ids } };
  await raw.paymentAllocation.deleteMany({ where });
  await raw.paymentAllocationMovement.deleteMany({ where });
  await raw.paymentPlanAmount.deleteMany({ where });
  await raw.patientCreditEntry.deleteMany({ where });
  await raw.patientCreditRefund.deleteMany({ where });
  await raw.patientCreditTransfer.deleteMany({ where });
  await raw.payment.deleteMany({ where });
  await raw.treatmentPlanItem.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.dentalCatalogItem.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
}

async function plan(): Promise<string> {
  return (
    await raw.treatmentPlan.create({
      data: { tenantId, patientId, currency: 'EUR', status: 'ACCEPTED' },
    })
  ).id;
}

async function item(
  planId: string,
  price: number,
  status: 'ACCEPTED' | 'PROPOSED' = 'ACCEPTED',
): Promise<string> {
  return (
    await raw.treatmentPlanItem.create({
      data: {
        tenantId,
        planId,
        toothNumber: String(11 + (seq++ % 20)),
        catalogItemId,
        price,
        status,
      },
    })
  ).id;
}

async function pay(
  planId: string,
  amount: number,
  registeredAt: Date,
  paidAt = DAY,
): Promise<string> {
  const payment = await raw.payment.create({
    data: {
      tenantId,
      locationId,
      treatmentPlanId: planId,
      patientId,
      amount,
      currency: 'EUR',
      paidAt,
      createdAt: registeredAt,
    },
  });
  await raw.paymentPlanAmount.create({
    data: {
      paymentId: payment.id,
      tenantId,
      treatmentPlanId: planId,
      amount,
      currency: 'EUR',
      rateDate: DAY,
    },
  });
  return payment.id;
}

/**
 * Salida del saldo a favor del plan (asiento con signo, en la moneda del plan),
 * con su devolución o traspaso real. `createdAt` lo pone la BD (ahora).
 */
async function creditOut(
  planId: string,
  amount: number,
  kind: 'REFUND' | 'TRANSFER_OUT' = 'REFUND',
  db: Prisma.TransactionClient = raw,
) {
  const common = { tenantId, patientId, currency: 'EUR', amount };
  if (kind === 'REFUND') {
    const refund = await db.patientCreditRefund.create({
      data: {
        ...common,
        locationId,
        treatmentPlanId: planId,
        method: 'TRANSFER',
        reason: 'Devolución',
        seriesPrefix: 'DEV-T',
        number: ++seq + 1000,
        snapshot: {},
        createdById: randomUUID(),
      },
    });
    return db.patientCreditEntry.create({
      data: {
        ...common,
        amount: -amount,
        treatmentPlanId: planId,
        kind,
        refundId: refund.id,
      },
    });
  }
  const transfer = await db.patientCreditTransfer.create({
    data: {
      ...common,
      locationId,
      sourcePlanId: planId,
      targetPlanId: await plan(),
      createdById: randomUUID(),
    },
  });
  return db.patientCreditEntry.create({
    data: {
      ...common,
      amount: -amount,
      treatmentPlanId: planId,
      kind,
      transferId: transfer.id,
    },
  });
}

const rebalance = (planId: string) =>
  inTenant(() => rebalancer.rebalancePlan(planId, null));

async function allocatedBy(paymentId: string): Promise<number> {
  const rows = await raw.paymentAllocation.findMany({ where: { paymentId } });
  return rows.reduce((n, r) => n + Math.round(Number(r.amount) * 100), 0);
}
async function allocatedTo(itemId: string): Promise<number> {
  const rows = await raw.paymentAllocation.findMany({
    where: { treatmentPlanItemId: itemId },
  });
  return rows.reduce((n, r) => n + Math.round(Number(r.amount) * 100), 0);
}
async function planTotal(planId: string): Promise<number> {
  const rows = await raw.paymentAllocation.findMany({
    where: { treatmentPlanId: planId },
  });
  return rows.reduce((n, r) => n + Math.round(Number(r.amount) * 100), 0);
}

describe('La imputación automática descuenta lo devuelto o traspasado (DX-399-bis)', () => {
  beforeAll(async () => {
    await cleanup();
    const tenant = await raw.tenant.create({
      data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
    });
    tenantId = tenant.id;
    locationId = (
      await raw.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, {
          tenantId,
          name: 'Sede',
        }),
      })
    ).id;
    patientId = (
      await raw.patient.create({
        data: { tenantId, firstName: 'Ana', lastName: 'Devuelta' },
      })
    ).id;
    catalogItemId = (
      await raw.dentalCatalogItem.create({
        data: {
          tenantId,
          code: 'dx399bis',
          kind: 'PROCEDURE',
          labelEs: 'Resina',
          color: '#123456',
        },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  it('la secuencia del ticket: el abono antiguo no cubre el ítem nuevo, el nuevo sí, y los totales no se mueven', async () => {
    const planId = await plan();
    const first = await item(planId, 100);
    const old = await pay(planId, 130, at(0));
    await rebalance(planId);
    expect(await allocatedBy(old)).toBe(10_000);

    await creditOut(planId, 30);
    const second = await item(planId, 30);
    // Los 30 del abono antiguo ya se devolvieron: no hay nada que repartir.
    expect(await rebalance(planId)).toEqual({ allocatedCents: 0 });
    expect(await allocatedTo(second)).toBe(0);
    expect(await allocatedBy(old)).toBe(10_000);

    const fresh = await pay(planId, 30, new Date());
    expect(await rebalance(planId)).toEqual({ allocatedCents: 3_000 });
    expect(await allocatedBy(fresh)).toBe(3_000);
    expect(await allocatedTo(second)).toBe(3_000);
    expect(await allocatedTo(first)).toBe(10_000);

    // Reimputar el plan otra vez no cambia nada (invariantes DX-054).
    const before = await planTotal(planId);
    expect(await rebalance(planId)).toEqual({ allocatedCents: 0 });
    expect(await planTotal(planId)).toBe(before);
    expect(before).toBe(13_000);
  });

  it('un traspaso de salida descuenta igual que una devolución', async () => {
    const planId = await plan();
    await item(planId, 100);
    const old = await pay(planId, 130, at(0));
    await rebalance(planId);
    await creditOut(planId, 30, 'TRANSFER_OUT');
    const extra = await item(planId, 30);
    await rebalance(planId);
    expect(await allocatedTo(extra)).toBe(0);
    expect(await allocatedBy(old)).toBe(10_000);
  });

  it('una devolución parcial deja repartir solo lo que queda a cuenta', async () => {
    const planId = await plan();
    await item(planId, 100);
    const old = await pay(planId, 130, at(0));
    await rebalance(planId);
    await creditOut(planId, 10);
    const extra = await item(planId, 30);
    expect(await rebalance(planId)).toEqual({ allocatedCents: 2_000 });
    expect(await allocatedTo(extra)).toBe(2_000);
    expect(await allocatedBy(old)).toBe(12_000);
  });

  it('una devolución solo descuenta abonos registrados ANTES: uno posterior sigue disponible', async () => {
    const planId = await plan();
    await item(planId, 100);
    const old = await pay(planId, 130, at(0));
    await rebalance(planId);
    await creditOut(planId, 30);
    const later = await pay(planId, 50, new Date());
    const extra = await item(planId, 50);
    await rebalance(planId);
    expect(await allocatedBy(later)).toBe(5_000);
    expect(await allocatedTo(extra)).toBe(5_000);
    expect(await allocatedBy(old)).toBe(10_000);
  });

  it('con dos abonos con sobrante, la salida absorbe el más reciente y el antiguo sigue disponible', async () => {
    const planId = await plan();
    const old = await pay(
      planId,
      30,
      at(0),
      new Date('2026-10-18T00:00:00.000Z'),
    );
    const recent = await pay(
      planId,
      30,
      at(1),
      new Date('2026-10-19T00:00:00.000Z'),
    );
    await creditOut(planId, 30);
    await item(planId, 30);
    await rebalance(planId);
    expect(await allocatedBy(recent)).toBe(0);
    expect(await allocatedBy(old)).toBe(3_000);
  });

  it('una devolución que espera al reparto (o al revés) se ordena por el bloqueo del plan: el reparto ve el asiento confirmado', async () => {
    const planId = await plan();
    await item(planId, 100);
    const old = await pay(planId, 130, at(0));
    await rebalance(planId);
    const extra = await item(planId, 30);

    // La devolución toma el plan FOR NO KEY UPDATE (como PrismaPatientCreditRepository)…
    const held = gate<string>();
    const release = gate();
    const refunding = settle(
      raw.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "treatment_plans"
           WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${planId}::uuid
             FOR NO KEY UPDATE`;
        held.open(await transactionId(tx));
        await release.wait;
        await creditOut(planId, 30, 'REFUND', tx);
      }),
    );
    const xid = await held.wait;
    // …y el reparto espera su FOR SHARE del plan.
    const spreading = settle(rebalance(planId));
    await waitForTransactionWaiters(raw, xid);
    release.open();
    const [refund, spread] = await Promise.all([refunding, spreading]);
    expect(refund.status).toBe('fulfilled');
    expect(spread).toEqual({
      status: 'fulfilled',
      value: { allocatedCents: 0 },
    });
    expect(await allocatedTo(extra)).toBe(0);
    expect(await allocatedBy(old)).toBe(10_000);
  });
});
