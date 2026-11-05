import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPlanAllocationRepository } from '../src/modules/payments/infrastructure/allocations/prisma-plan-allocation.repository';
import { findAffectedPlans } from '../src/modules/payments/infrastructure/allocations/credit-netting-facts';
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

/**
 * Abono registrado DESPUÉS del último asiento del plan, medido con el reloj de
 * la BD (que es quien pone el `createdAt` del asiento): sin depender del reloj
 * de Node.
 */
async function payAfterCredit(planId: string, amount: number) {
  const id = await pay(planId, amount, at(0));
  await raw.$executeRaw`
    UPDATE "payments"
       SET "createdAt" = (SELECT max(e."createdAt") FROM "patient_credit_entries" e
                           WHERE e."treatmentPlanId" = ${planId}::uuid)
                         + interval '1 second'
     WHERE "id" = ${id}::uuid`;
  return id;
}

/**
 * DX-399-ter: traspaso RECIBIDO por el plan desde otro plan del paciente: el
 * par de asientos (sale del origen, entra en el destino). `createdAt` lo pone
 * la BD (ahora).
 */
async function creditIn(
  planId: string,
  amount: number,
  from?: string,
): Promise<void> {
  const common = { tenantId, patientId, currency: 'EUR' };
  // Sin origen dado, uno con su propio abono sin imputar: de ahí sale el traspaso.
  let sourcePlanId = from;
  if (!sourcePlanId) {
    sourcePlanId = await plan();
    await pay(sourcePlanId, amount, at(0));
  }
  const transfer = await raw.patientCreditTransfer.create({
    data: {
      ...common,
      amount,
      locationId,
      sourcePlanId,
      targetPlanId: planId,
      createdById: randomUUID(),
    },
  });
  await raw.patientCreditEntry.create({
    data: {
      ...common,
      amount: -amount,
      treatmentPlanId: sourcePlanId,
      kind: 'TRANSFER_OUT',
      transferId: transfer.id,
    },
  });
  await raw.patientCreditEntry.create({
    data: {
      ...common,
      amount,
      treatmentPlanId: planId,
      kind: 'TRANSFER_IN',
      transferId: transfer.id,
    },
  });
}

/**
 * El saldo del plan como lo da Cartera (DX-253/DX-430): lo cobrado con base −
 * lo facturable (ítems vivos ACCEPTED|DONE) + los asientos del saldo a favor.
 */
async function planBalanceCents(planId: string): Promise<number> {
  const [row] = await raw.$queryRaw<{ cents: bigint }[]>`
    SELECT round((
      COALESCE((SELECT sum(b."amount") FROM "payment_plan_amounts" b
                  JOIN "payments" p ON p."id" = b."paymentId"
                 WHERE b."treatmentPlanId" = ${planId}::uuid AND p."deletedAt" IS NULL), 0)
      - COALESCE((SELECT sum(i."price" - i."discount") FROM "treatment_plan_items" i
                    JOIN "treatment_plans" tp ON tp."id" = i."planId"
                   WHERE i."planId" = ${planId}::uuid AND i."deletedAt" IS NULL
                     AND i."status" IN ('ACCEPTED', 'DONE')
                     AND tp."status" NOT IN ('CANCELLED', 'REJECTED')), 0)
      + COALESCE((SELECT sum(e."amount") FROM "patient_credit_entries" e
                   WHERE e."treatmentPlanId" = ${planId}::uuid), 0)
    ) * 100)::bigint AS "cents"`;
  return Number(row.cents);
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

    const fresh = await payAfterCredit(planId, 30);
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
    const later = await payAfterCredit(planId, 50);
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
  it('DX-399-ter, la secuencia del ticket: excedente propio, traspaso recibido, devolución de 30 e ítem nuevo -> el abono cubre el ítem y nada queda pendiente con el saldo en 0', async () => {
    const planId = await plan();
    const first = await item(planId, 70);
    const own = await pay(planId, 100, at(0));
    await rebalance(planId);
    expect(await allocatedBy(own)).toBe(7_000);

    // Recibe 30 por traspaso y luego se le devuelven 30: la devolución sale
    // del saldo recibido, que no se puede imputar; el abono conserva sus 30.
    await creditIn(planId, 30);
    await creditOut(planId, 30);
    const second = await item(planId, 30);
    expect(await rebalance(planId)).toEqual({ allocatedCents: 3_000 });
    expect(await allocatedTo(second)).toBe(3_000);
    expect(await allocatedTo(first)).toBe(7_000);
    expect(await allocatedBy(own)).toBe(10_000);
    // Cartera: 100 − 100 + 30 − 30 = 0, y ningún ítem pendiente.
    expect(await planBalanceCents(planId)).toBe(0);

    // La cascada (informe, ventana, diagnóstico) no descarta nada.
    const affected = await inTenant(() =>
      prisma.runWithTenant((tx) => findAffectedPlans(tx, tenantId)),
    );
    expect(affected.map((p) => p.planId)).not.toContain(planId);

    // Reimputar no mueve nada (invariantes DX-054).
    expect(await rebalance(planId)).toEqual({ allocatedCents: 0 });
    expect(await planTotal(planId)).toBe(10_000);
  });

  it('DX-399-ter: una devolución mayor que lo recibido por traspaso sale del abono por lo que falta', async () => {
    const planId = await plan();
    await item(planId, 50);
    const own = await pay(planId, 100, at(0));
    await rebalance(planId);
    await creditIn(planId, 20);
    // Saldo 70: se devuelven 50 -> 20 del traspaso y 30 del abono.
    await creditOut(planId, 50);
    const extra = await item(planId, 50);
    expect(await rebalance(planId)).toEqual({ allocatedCents: 2_000 });
    expect(await allocatedTo(extra)).toBe(2_000);
    expect(await allocatedBy(own)).toBe(7_000);
    // Lo que queda pendiente (30) es exactamente lo que dice Cartera (−30).
    expect(await planBalanceCents(planId)).toBe(-3_000);
  });

  it('DX-399-ter, diagnóstico: una devolución que absorbe un traspaso recibido no es dinero descartado', async () => {
    const planId = await plan();
    await item(planId, 100);
    await pay(planId, 100, at(0));
    await rebalance(planId);
    await creditIn(planId, 30);
    await creditOut(planId, 30);
    const affected = await inTenant(() =>
      prisma.runWithTenant((tx) => findAffectedPlans(tx, tenantId)),
    );
    expect(affected.map((p) => p.planId)).not.toContain(planId);
  });
  it('DX-399-ter (F2), ida y vuelta: P traspasa 30 a Q, Q se los devuelve y un ítem nuevo de P queda cubierto (saldo 0, nada pendiente)', async () => {
    const p = await plan();
    const first = await item(p, 70);
    const own = await pay(p, 100, at(0));
    await rebalance(p);
    const q = await plan();
    await item(q, 20);
    await pay(q, 20, at(0));
    await rebalance(q);
    // P -> Q 30 (sale del excedente de P: aún no había nada recibido) y Q -> P 30.
    await creditIn(q, 30, p);
    await creditIn(p, 30, q);
    const second = await item(p, 30);
    // Lo recibido de vuelta absorbe la salida anterior: el abono recupera sus 30.
    expect(await rebalance(p)).toEqual({ allocatedCents: 3_000 });
    expect(await allocatedTo(second)).toBe(3_000);
    expect(await allocatedTo(first)).toBe(7_000);
    expect(await allocatedBy(own)).toBe(10_000);
    expect(await planBalanceCents(p)).toBe(0);
    expect(await planBalanceCents(q)).toBe(0);
    const affected = await inTenant(() =>
      prisma.runWithTenant((tx) => findAffectedPlans(tx, tenantId)),
    );
    expect(affected.map((x) => x.planId)).not.toContain(p);
    expect(affected.map((x) => x.planId)).not.toContain(q);
  });

  it('DX-399-ter (F1): plan cancelado y devuelto entero -> el estado de cuenta y la ventana dan 0 a cuenta, como Cartera', async () => {
    const planId = await plan();
    await item(planId, 100);
    const paid = await pay(planId, 100, at(0));
    await rebalance(planId);
    // Cancelar libera las imputaciones (DX-109); luego se devuelve todo.
    await raw.treatmentPlan.update({
      where: { id: planId },
      data: { status: 'CANCELLED' },
    });
    await raw.paymentAllocation.deleteMany({ where: { paymentId: paid } });
    await creditOut(planId, 100);
    const snapshot = await inTenant(() =>
      allocationRepo.readPlanBalanceSnapshot(planId),
    );
    expect(snapshot?.creditOutCents).toBe(10_000);
    const window = await inTenant(() =>
      allocationRepo.readPaymentAllocations(paid),
    );
    expect(window?.creditOutCents).toBe(10_000);
    expect(await planBalanceCents(planId)).toBe(0);
  });

  it('diagnóstico (solo lectura): lista el plan que dejó el fallo y no el sano; reparar no es automático', async () => {
    const healthy = await plan();
    await item(healthy, 100);
    await pay(healthy, 130, at(0));
    await rebalance(healthy);
    await creditOut(healthy, 30);

    // El estado del fallo previo: el abono antiguo quedó imputado entero (100 + 30)
    // y luego se devolvieron 30 -> la salida no se atribuye a ningún abono.
    const broken = await plan();
    await item(broken, 100);
    await item(broken, 30);
    const old = await pay(broken, 130, at(0));
    await rebalance(broken);
    expect(await allocatedBy(old)).toBe(13_000);
    await creditOut(broken, 30);

    const before = await planTotal(broken);
    const affected = await inTenant(() =>
      prisma.runWithTenant((tx) => findAffectedPlans(tx, tenantId)),
    );
    expect(affected.map((p) => p.planId)).toEqual([broken]);
    expect(affected[0]).toMatchObject({
      creditOutCents: 3_000,
      attributedCents: 0,
      discardedCents: 3_000,
    });
    // Solo lee: nada cambió.
    expect(await planTotal(broken)).toBe(before);
  });

  it('diagnóstico: no lista planes cancelados ni de pacientes borrados (devolver desde ahí es normal), y su transacción es de solo lectura', async () => {
    // Plan cancelado con devolución: sin imputaciones, el fallo no pudo tocarlo.
    const cancelled = await plan();
    await item(cancelled, 100);
    await pay(cancelled, 130, at(0));
    await creditOut(cancelled, 130);
    await raw.treatmentPlan.update({
      where: { id: cancelled },
      data: { status: 'CANCELLED' },
    });
    // Paciente borrado con el mismo patrón del fallo.
    const gone = await raw.patient.create({
      data: { tenantId, firstName: 'Borrada', lastName: 'Devuelta' },
    });
    const gonePlan = (
      await raw.treatmentPlan.create({
        data: {
          tenantId,
          patientId: gone.id,
          currency: 'EUR',
          status: 'ACCEPTED',
        },
      })
    ).id;
    await raw.payment.create({
      data: {
        tenantId,
        locationId,
        treatmentPlanId: gonePlan,
        patientId: gone.id,
        amount: 30,
        currency: 'EUR',
        paidAt: DAY,
        createdAt: at(0),
      },
    });
    await raw.patientCreditEntry.deleteMany({ where: { patientId: gone.id } });
    const refund = await raw.patientCreditRefund.create({
      data: {
        tenantId,
        patientId: gone.id,
        locationId,
        treatmentPlanId: gonePlan,
        currency: 'EUR',
        amount: 30,
        method: 'TRANSFER',
        reason: 'Devolución',
        seriesPrefix: 'DEV-T',
        number: ++seq + 2000,
        snapshot: {},
        createdById: randomUUID(),
      },
    });
    await raw.patientCreditEntry.create({
      data: {
        tenantId,
        patientId: gone.id,
        treatmentPlanId: gonePlan,
        currency: 'EUR',
        amount: -30,
        kind: 'REFUND',
        refundId: refund.id,
      },
    });
    await raw.patient.update({
      where: { id: gone.id },
      data: { deletedAt: new Date() },
    });

    const affected = await inTenant(() =>
      prisma.runWithTenant(async (tx) => {
        await tx.$executeRaw`SELECT set_config('transaction_read_only', 'on', true)`;
        const found = await findAffectedPlans(tx, tenantId);
        await expect(
          tx.$executeRaw`UPDATE "treatment_plans" SET "notes" = 'x' WHERE "id" = ${cancelled}::uuid`,
        ).rejects.toThrow(/read-only/i);
        return found;
      }),
    );
    const ids = affected.map((p) => p.planId);
    expect(ids).not.toContain(cancelled);
    expect(ids).not.toContain(gonePlan);
  });
});
