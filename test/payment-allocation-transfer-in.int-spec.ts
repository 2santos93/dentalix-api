import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPlanAllocationRepository } from '../src/modules/payments/infrastructure/allocations/prisma-plan-allocation.repository';
import { findAffectedPlans } from '../src/modules/payments/infrastructure/allocations/credit-netting-facts';
import { PlanAllocationRebalancer } from '../src/modules/payments/application/plan-allocation-rebalancer';
import { PrismaPatientCreditRepository } from '../src/modules/patient-credit/infrastructure/prisma-patient-credit.repository';
import type { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import { purgeTenantsBySubdomain } from './support/tenant-purge';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-399-quater, capa DB: el saldo que un plan recibe por traspaso es dinero
// del paciente que ya está en el plan y cubre ítems, después del excedente de
// los abonos. Secuencia del ticket: excedente propio 30, 30 recibidos por
// traspaso, ítem nuevo de 60 -> el ítem queda pagado (30 del abono, 30 de lo
// recibido) y el saldo tipo Cartera es 0. Todo en USD.
// `raw` (DIRECT_URL, superusuario) siembra y observa; el reparto y las
// lecturas van por la app (RLS).
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
const creditRepo = new PrismaPatientCreditRepository(prisma, tenantContext);

const SUBDOMAIN = 'dx399q-int';
const T0 = new Date('2026-10-20T15:00:00.000Z');
const DAY = new Date('2026-10-20T00:00:00.000Z');

let tenantId: string;
let locationId: string;
let patientId: string;
let catalogItemId: string;
let seq = 0;

const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(tenantId, undefined, fn);

/** Todas las filas de la clínica del test (devoluciones, contadores, auditoría…). */
const cleanup = () => purgeTenantsBySubdomain(raw, [SUBDOMAIN]);

async function plan(currency = 'USD'): Promise<string> {
  return (
    await raw.treatmentPlan.create({
      data: { tenantId, patientId, currency, status: 'ACCEPTED' },
    })
  ).id;
}

async function item(planId: string, price: number): Promise<string> {
  return (
    await raw.treatmentPlanItem.create({
      data: {
        tenantId,
        planId,
        toothNumber: String(11 + (seq++ % 20)),
        catalogItemId,
        price,
        status: 'ACCEPTED',
      },
    })
  ).id;
}

async function pay(planId: string, amount: number): Promise<string> {
  const payment = await raw.payment.create({
    data: {
      tenantId,
      locationId,
      treatmentPlanId: planId,
      patientId,
      amount,
      currency: 'USD',
      paidAt: DAY,
      createdAt: T0,
    },
  });
  await raw.paymentPlanAmount.create({
    data: {
      paymentId: payment.id,
      tenantId,
      treatmentPlanId: planId,
      amount,
      currency: 'USD',
      rateDate: DAY,
    },
  });
  return payment.id;
}

/** Traspaso por el repositorio real (DX-253), como la ruta: encola los dos planes. */
const transfer = (sourcePlanId: string, targetPlanId: string, amount: number) =>
  tenantContext.run(tenantId, locationId, () =>
    creditRepo.createTransfer({
      sourcePlanId,
      targetPlanId,
      amountCents: amount * 100,
      currency: 'USD',
      reason: null,
      userId: randomUUID(),
      fingerprint: randomUUID(),
    }),
  );

/** Otro plan del paciente con `amount` a cuenta, que se traspasan a `planId`. */
async function receive(planId: string, amount: number): Promise<void> {
  const source = await plan();
  await pay(source, amount);
  await transfer(source, planId, amount);
}

/** Devolución por el repositorio real, desde los abonos dados. */
const refund = (planId: string, paymentIds: string[], amount: number) =>
  tenantContext.run(tenantId, locationId, () =>
    creditRepo.createRefund({
      planId,
      amountCents: amount * 100,
      currency: 'USD',
      method: 'TRANSFER',
      reason: 'El paciente se muda',
      paymentIds,
      userId: randomUUID(),
      fingerprint: randomUUID(),
    }),
  );

/** El drenado de la cola tras una escritura (lo que hace el interceptor). */
const drain = (preferPlanId: string) =>
  inTenant(() =>
    rebalancer.drainPending({ actorId: null, preferPlanId, limit: 100 }),
  );

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
                   WHERE i."planId" = ${planId}::uuid AND i."deletedAt" IS NULL
                     AND i."status" IN ('ACCEPTED', 'DONE')), 0)
      + COALESCE((SELECT sum(e."amount") FROM "patient_credit_entries" e
                   WHERE e."treatmentPlanId" = ${planId}::uuid), 0)
    ) * 100)::bigint AS "cents"`;
  return Number(row.cents);
}

async function allocatedTo(itemId: string): Promise<number> {
  const rows = await raw.paymentAllocation.findMany({
    where: { treatmentPlanItemId: itemId },
  });
  return rows.reduce((n, r) => n + Math.round(Number(r.amount) * 100), 0);
}

const snapshotOf = async (planId: string) => {
  const snapshot = await inTenant(() =>
    allocationRepo.readPlanBalanceSnapshot(planId),
  );
  if (!snapshot) throw new Error('sin foto');
  return snapshot;
};

/** Lo pendiente de cada ítem del plan: facturable − imputado − lo que cubre lo recibido. */
async function pendingOf(planId: string): Promise<Map<string, number>> {
  const snapshot = await snapshotOf(planId);
  const pending = new Map<string, number>();
  for (const i of snapshot.items) {
    const billable = Math.round((i.price - i.discount) * 100);
    const allocated = snapshot.allocations
      .filter((a) => a.itemId === i.id)
      .reduce((n, a) => n + Math.round(a.amount * 100), 0);
    pending.set(
      i.id,
      billable - allocated - (snapshot.transfersIn.byItem.get(i.id) ?? 0),
    );
  }
  return pending;
}

/** El ítem nuevo de 60 del ticket sobre P (ítem 70, abono 100 ya repartido). */
async function ticketPlan(): Promise<{
  p: string;
  own: string;
  first: string;
}> {
  const p = await plan();
  const first = await item(p, 70);
  const own = await pay(p, 100);
  await drain(p);
  expect(await allocatedTo(first)).toBe(7_000);
  return { p, own, first };
}

describe('El saldo recibido por traspaso cubre ítems (DX-399-quater)', () => {
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
          name: 'Sede Chacao',
        }),
      })
    ).id;
    patientId = (
      await raw.patient.create({
        data: { tenantId, firstName: 'Ana', lastName: 'Traspasada' },
      })
    ).id;
    catalogItemId = (
      await raw.dentalCatalogItem.create({
        data: {
          tenantId,
          code: 'dx399q',
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

  it('la secuencia del ticket: excedente 30, 30 recibidos e ítem de 60 -> el ítem queda pagado (30 + 30), sin intervención, y Cartera 0', async () => {
    const { p, own, first } = await ticketPlan();
    await receive(p, 30);
    const second = await item(p, 60);
    // Lo que hace el interceptor tras aceptar el ítem.
    await drain(p);
    // Primero el excedente del abono (como hoy)…
    expect(await allocatedTo(second)).toBe(3_000);
    // …y lo recibido por traspaso cubre el resto.
    const snapshot = await snapshotOf(p);
    expect(snapshot.transfersIn.leftCents).toBe(3_000);
    expect([...snapshot.transfersIn.byItem]).toEqual([[second, 3_000]]);
    expect(await pendingOf(p)).toEqual(
      new Map([
        [first, 0],
        [second, 0],
      ]),
    );
    expect(await planBalanceCents(p)).toBe(0);
    // «Ver imputación» del abono: de dónde sale lo que cubre cada ítem.
    const window = await inTenant(() =>
      allocationRepo.readPaymentAllocations(own),
    );
    const second_ = window?.items.find((i) => i.id === second);
    expect(second_).toMatchObject({
      billableCents: 6_000,
      paidByOthersCents: 0,
      paidByTransfersInCents: 3_000,
    });
    expect(
      window?.items.find((i) => i.id === first)?.paidByTransfersInCents ?? 0,
    ).toBe(0);
    // El diagnóstico no ve nada descartado y reimputar no mueve nada.
    const affected = await inTenant(() =>
      prisma.runWithTenant((tx) => findAffectedPlans(tx, tenantId)),
    );
    expect(affected.map((x) => x.planId)).not.toContain(p);
    expect(await inTenant(() => rebalancer.rebalancePlan(p, null))).toEqual({
      allocatedCents: 0,
    });
  });

  it('traspaso parcial: 10 recibidos cubren 10 y lo pendiente (20) es lo que dice Cartera', async () => {
    const { p } = await ticketPlan();
    await receive(p, 10);
    const second = await item(p, 60);
    await drain(p);
    const snapshot = await snapshotOf(p);
    expect(snapshot.transfersIn.byItem.get(second)).toBe(1_000);
    expect((await pendingOf(p)).get(second)).toBe(2_000);
    expect(await planBalanceCents(p)).toBe(-2_000);
  });

  it('traspaso y luego devolución de lo recibido: no se gasta dos veces, el ítem nuevo queda pendiente por lo que dice Cartera', async () => {
    const { p, own } = await ticketPlan();
    await receive(p, 30);
    // Saldo 60: se devuelven 30, que salen de lo recibido (DX-399-ter).
    await refund(p, [own], 30);
    const second = await item(p, 60);
    await drain(p);
    expect(await allocatedTo(second)).toBe(3_000);
    const snapshot = await snapshotOf(p);
    expect(snapshot.transfersIn.leftCents).toBe(0);
    expect(snapshot.transfersIn.byItem.size).toBe(0);
    expect((await pendingOf(p)).get(second)).toBe(3_000);
    expect(await planBalanceCents(p)).toBe(-3_000);
  });

  it('un ítem mayor que todo el crédito: abono 30 + recibido 30, y el resto (40) pendiente = Cartera', async () => {
    const { p } = await ticketPlan();
    await receive(p, 30);
    const big = await item(p, 100);
    await drain(p);
    expect(await allocatedTo(big)).toBe(3_000);
    expect((await snapshotOf(p)).transfersIn.byItem.get(big)).toBe(3_000);
    expect((await pendingOf(p)).get(big)).toBe(4_000);
    expect(await planBalanceCents(p)).toBe(-4_000);
  });

  it('un ítem anulado libera lo recibido: vuelve a quedar a cuenta, y un ítem posterior lo usa', async () => {
    const { p } = await ticketPlan();
    await receive(p, 30);
    const second = await item(p, 60);
    await drain(p);
    expect((await snapshotOf(p)).transfersIn.byItem.get(second)).toBe(3_000);
    // Se anula el ítem (baja lógica, como la ruta): la BD libera lo imputado.
    await inTenant(() =>
      prisma.runWithTenant((tx) =>
        tx.treatmentPlanItem.update({
          where: { id: second },
          data: { deletedAt: new Date() },
        }),
      ),
    );
    expect(await allocatedTo(second)).toBe(0);
    const freed = await snapshotOf(p);
    expect(freed.transfersIn.leftCents).toBe(3_000);
    expect(freed.transfersIn.byItem.size).toBe(0);
    expect(await planBalanceCents(p)).toBe(6_000);
    // Un ítem nuevo de 40: el abono (30 liberados) y luego 10 de lo recibido.
    const third = await item(p, 40);
    await inTenant(() =>
      prisma.runWithTenant((tx) => allocationRepo.enqueuePlan(tx, tenantId, p)),
    );
    await drain(p);
    expect(await allocatedTo(third)).toBe(3_000);
    expect((await snapshotOf(p)).transfersIn.byItem.get(third)).toBe(1_000);
    expect((await pendingOf(p)).get(third)).toBe(0);
    expect(await planBalanceCents(p)).toBe(2_000);
  });

  it('un plan sin traspasos queda exactamente igual: nada cubierto por lo recibido', async () => {
    const p = await plan();
    await item(p, 70);
    await pay(p, 50);
    await drain(p);
    const snapshot = await snapshotOf(p);
    expect(snapshot.transfersIn).toEqual({ leftCents: 0, byItem: new Map() });
    const window = await inTenant(() =>
      allocationRepo.readPaymentAllocations(snapshot.payments[0].id),
    );
    expect(window?.items[0].paidByTransfersInCents ?? 0).toBe(0);
  });

  it('F6: un asiento en otra moneda que la del plan no cuenta (como el saldo del plan), ni para cubrir ni para salir', async () => {
    const p = await plan();
    const only = await item(p, 50);
    await pay(p, 20);
    await drain(p);
    // Un traspaso recibido en VES sobre un plan en USD (no debería existir:
    // DX-438 bloquea cambiar la moneda con asientos): el saldo del plan no lo
    // suma, así que tampoco cubre ítems.
    const source = await plan('VES');
    const t = await raw.patientCreditTransfer.create({
      data: {
        tenantId,
        locationId,
        patientId,
        sourcePlanId: source,
        targetPlanId: p,
        currency: 'VES',
        amount: 30,
        createdById: randomUUID(),
      },
    });
    await raw.patientCreditEntry.create({
      data: {
        tenantId,
        patientId,
        treatmentPlanId: p,
        currency: 'VES',
        amount: 30,
        kind: 'TRANSFER_IN',
        transferId: t.id,
      },
    });
    const snapshot = await snapshotOf(p);
    expect(snapshot.transfersIn.leftCents).toBe(0);
    expect(snapshot.transfersIn.byItem.has(only)).toBe(false);
  });
});
