import { createHash, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

// DX-051 Task 3 por HTTP: el alta de un abono crea su base y el interceptor
// reparte tras el COMMIT, en la misma petición; la anulación borra sus
// imputaciones y el hueco lo llena otro abono; ninguna ruta mutadora deja el
// plan en la cola. Las aserciones leen las filas de `payment_allocations` y
// `payment_plan_amounts` con `raw` (el `…/balance` por ítem llega en Task 4).
// Tasa EUR del día sembrada como payments.e2e-spec.ts (sin proveedor: 1 USD =
// 0,9 EUR); GBP no tiene tasa ese día.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const RATE_DATE = '2026-07-01';
const EARLIER = '2026-06-15';
const RATE_EUR = 0.9;
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SIGNATURE = `data:image/png;base64,${PNG}`;
const TEETH = [11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28];
let toothSeq = 0;

interface Balance {
  billable: number;
  paid: number;
  balance: number;
}

interface ItemBalance {
  itemId: string;
  toothNumber: string;
  procedureName: string;
  status: string;
  billable: number;
  paid: number;
  balance: number;
}

interface FullBalance extends Balance {
  allocated: number;
  unallocated: number;
  unconvertedPaymentsCount: number;
  manualPaymentIds: string[];
  items: ItemBalance[];
}

interface Statement {
  summary: {
    currency: string;
    budgeted: number;
    paid: number;
    balance: number;
  }[];
  plans: { id: string; paid: number; balance: number }[];
}

describe('Imputación automática de abonos (DX-051, e2e)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let patientId: string;
  let catalogItemId: string;
  let locationId: string;

  const api = () => {
    const server = app.getHttpServer();
    const auth = (t: request.Test) =>
      t
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`);
    return {
      get: (path: string) => auth(request(server).get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        auth(request(server).post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) =>
        auth(request(server).patch(`/api/v1${path}`)).send(body),
      delete: (path: string, body: object = {}) =>
        auth(request(server).delete(`/api/v1${path}`)).send(body),
    };
  };

  async function createPlan(currency = 'EUR'): Promise<string> {
    const res = await api()
      .post(`/patients/${patientId}/treatment-plans`, { currency })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function addItem(
    planId: string,
    price: number,
    status: 'PROPOSED' | 'ACCEPTED' | 'DONE' = 'PROPOSED',
  ): Promise<string> {
    const res = await api()
      .post(`/treatment-plans/${planId}/items`, {
        toothNumber: String(TEETH[toothSeq++ % TEETH.length]),
        catalogItemId,
        price,
      })
      .expect(201);
    const itemId = (res.body as { id: string }).id;
    if (status !== 'PROPOSED') await setStatus(planId, itemId, status);
    return itemId;
  }

  async function setStatus(
    planId: string,
    itemId: string,
    status: 'ACCEPTED' | 'DONE',
  ): Promise<void> {
    await api()
      .patch(`/treatment-plans/${planId}/items/${itemId}`, { status })
      .expect(200);
  }

  async function pay(
    planId: string,
    amount: number,
    opts: { currency?: string; paidAt?: string; key?: string } = {},
  ): Promise<string> {
    const req = api().post(`/treatment-plans/${planId}/payments`, {
      amount,
      currency: opts.currency ?? 'EUR',
      paidAt: opts.paidAt ?? RATE_DATE,
      method: 'TRANSFER',
    });
    if (opts.key) req.set('Idempotency-Key', opts.key);
    const res = await req.expect(201);
    return (res.body as { id: string }).id;
  }

  async function voidPayment(paymentId: string): Promise<void> {
    await api()
      .delete(`/payments/${paymentId}`, { reason: 'Registrado por error' })
      .expect(200);
  }

  /** Céntimos imputados por ítem de un abono (filas vivas). */
  async function rowsOf(paymentId: string): Promise<Record<string, number>> {
    const rows = await raw.paymentAllocation.findMany({ where: { paymentId } });
    return Object.fromEntries(
      rows.map((r) => [r.treatmentPlanItemId, Number(r.amount)]),
    );
  }

  async function baseOf(paymentId: string): Promise<number | null> {
    const base = await raw.paymentPlanAmount.findUnique({
      where: { paymentId },
    });
    return base ? Number(base.amount) : null;
  }

  /** Solicitudes en la cola de toda la clínica. */
  const queued = () =>
    raw.planAllocationRebalanceRequest.count({
      where: { tenantId: clinic.tenantId },
    });

  async function fullBalanceOf(planId: string): Promise<FullBalance> {
    const res = await api()
      .get(`/treatment-plans/${planId}/balance`)
      .expect(200);
    return res.body as FullBalance;
  }

  async function balanceOf(planId: string): Promise<Balance> {
    const res = await api()
      .get(`/treatment-plans/${planId}/balance`)
      .expect(200);
    const { billable, paid, balance } = res.body as Balance;
    return { billable, paid, balance };
  }

  /** Totales por moneda y por plan del estado de cuenta (no el cuerpo entero). */
  async function statementTotals() {
    const res = await api()
      .get(`/patients/${patientId}/account-statement`)
      .expect(200);
    const body = res.body as Statement;
    return {
      summary: body.summary.map(({ currency, budgeted, paid, balance }) => ({
        currency,
        budgeted,
        paid,
        balance,
      })),
      plans: body.plans.map(({ id, paid, balance }) => ({ id, paid, balance })),
    };
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({ where: { date: RATE_DATE } });
    await raw.exchangeRateSnapshot.create({
      data: { date: RATE_DATE, currency: 'EUR', rate: RATE_EUR },
    });
    clinic = await registerClinic(app, 'dx051-alloc');
    locationId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
      })
    ).id;
    patientId = (
      await raw.patient.create({
        data: {
          tenantId: clinic.tenantId,
          firstName: 'Ana',
          lastName: 'Abono',
        },
      })
    ).id;
    catalogItemId = (
      (
        await api()
          .post('/catalog/items', {
            code: 'DX051-RESINA',
            kind: 'PROCEDURE',
            labelEs: 'Resina',
            color: '#2A2B3C',
            // Precio de catálogo mínimo: los precios del plan nunca son un descuento.
            defaultPrice: 1,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({ where: { date: RATE_DATE } });
    await app.close();
    await raw.$disconnect();
  });

  it('auto-allocates DONE then ACCEPTED with surplus unallocated', async () => {
    const planId = await createPlan();
    const done = await addItem(planId, 100, 'DONE');
    const accepted = await addItem(planId, 50, 'ACCEPTED');
    await addItem(planId, 70);

    const paymentId = await pay(planId, 180);

    expect(await rowsOf(paymentId)).toEqual({ [done]: 100, [accepted]: 50 });
    expect(await baseOf(paymentId)).toBe(180);
    const full = await fullBalanceOf(planId);
    expect(full.items.map((i) => i.paid)).toEqual([100, 50, 0]);
    expect(full).toMatchObject({ allocated: 150, unallocated: 30 });
    const rows = await raw.paymentAllocation.findMany({ where: { paymentId } });
    expect(rows.every((r) => r.source === 'AUTO')).toBe(true);
    expect(rows.every((r) => r.createdById === clinic.adminUserId)).toBe(true);
    expect(await queued()).toBe(0);
  });

  it('allocates a foreign-currency payment converted at its date', async () => {
    const planId = await createPlan('EUR');
    const done = await addItem(planId, 100, 'DONE');

    const paymentId = await pay(planId, 100, { currency: 'USD' });

    const base = await raw.paymentPlanAmount.findUniqueOrThrow({
      where: { paymentId },
    });
    expect(Number(base.amount)).toBe(Math.round(100 * RATE_EUR * 100) / 100);
    expect(base.currency).toBe('EUR');
    expect(base.rateDate.toISOString().slice(0, 10)).toBe(RATE_DATE);
    const rows = await rowsOf(paymentId);
    expect(rows).toEqual({ [done]: 90 });
    expect(Object.values(rows).reduce((s, v) => s + v, 0)).toBeLessThanOrEqual(
      Number(base.amount),
    );
    const full = await fullBalanceOf(planId);
    const itemsPaid = full.items.reduce((s, i) => s + i.paid, 0);
    expect(Math.round((itemsPaid + full.unallocated) * 100)).toBe(
      Math.round(full.paid * 100),
    );
  });

  it('payment without rate is recorded unallocated', async () => {
    const planId = await createPlan('EUR');
    await addItem(planId, 100, 'DONE');

    const paymentId = await pay(planId, 100, { currency: 'GBP' });

    expect(await baseOf(paymentId)).toBeNull();
    expect(await rowsOf(paymentId)).toEqual({});
    expect((await fullBalanceOf(planId)).unconvertedPaymentsCount).toBe(1);
  });

  it('balance counts a payment as unconverted when no rate can be fetched', async () => {
    const planId = await createPlan('EUR');
    await addItem(planId, 100, 'DONE');
    await pay(planId, 100);
    // Sin tasa guardada para ese día y sin proveedor: el cobro y el saldo no fallan.
    const paymentId = await pay(planId, 50, {
      currency: 'USD',
      paidAt: '2026-05-02',
    });

    expect(await baseOf(paymentId)).toBeNull();
    const full = await fullBalanceOf(planId);
    expect(full).toMatchObject({
      paid: 100,
      unconvertedPaymentsCount: 1,
      unallocated: 0,
    });
    expect(full.items.map((i) => i.paid)).toEqual([100]);
  });

  it('idempotent replay does not create a second base', async () => {
    const planId = await createPlan();
    await addItem(planId, 100, 'DONE');
    const key = randomUUID();

    const first = await pay(planId, 40, { key });
    const replay = await pay(planId, 40, { key });

    expect(replay).toBe(first);
    expect(
      await raw.paymentPlanAmount.count({ where: { treatmentPlanId: planId } }),
    ).toBe(1);
    expect(
      await raw.paymentAllocation.count({ where: { treatmentPlanId: planId } }),
    ).toBe(1);
  });

  it('voiding removes allocations and leaves totals as if never paid', async () => {
    const planId = await createPlan();
    await addItem(planId, 100, 'DONE');
    await addItem(planId, 50, 'ACCEPTED');
    const balanceBefore = await balanceOf(planId);
    const statementBefore = await statementTotals();

    const paymentId = await pay(planId, 120);
    expect(Object.keys(await rowsOf(paymentId))).toHaveLength(2);
    await voidPayment(paymentId);

    expect(await rowsOf(paymentId)).toEqual({});
    expect(await balanceOf(planId)).toEqual(balanceBefore);
    expect(await statementTotals()).toEqual(statementBefore);
    // El historial guarda la anulación con su causa.
    const voidMoves = await raw.paymentAllocationMovement.findMany({
      where: { paymentId, cause: 'VOID' },
    });
    expect(voidMoves.reduce((s, m) => s + Number(m.deltaCents), 0)).toBe(
      -12_000,
    );
    expect(await queued()).toBe(0);
  });

  it('voiding fills the freed item from an older payment surplus', async () => {
    const planId = await createPlan();
    const done = await addItem(planId, 100, 'DONE');
    const newer = await pay(planId, 100);
    // Cobrado antes pero registrado después: llega sin hueco que llenar.
    const older = await pay(planId, 100, { paidAt: EARLIER });
    expect(await rowsOf(older)).toEqual({});

    await voidPayment(newer);

    expect(await rowsOf(newer)).toEqual({});
    expect(await rowsOf(older)).toEqual({ [done]: 100 });
    expect(await queued()).toBe(0);
  });

  it('accepting the plan quote respreads surplus', async () => {
    const planId = await createPlan();
    const done = await addItem(planId, 100, 'DONE');
    const proposed = await addItem(planId, 50);
    const paymentId = await pay(planId, 150);
    expect(await rowsOf(paymentId)).toEqual({ [done]: 100 });

    const quote = await api()
      .get(`/patients/${patientId}/treatment-plans/${planId}/quote`)
      .expect(200);
    await api()
      .post(`/patients/${patientId}/treatment-plans/${planId}/acceptance`, {
        signerName: 'Ana Abono',
        signature: SIGNATURE,
        contentHash: (quote.body as { contentHash: string }).contentHash,
      })
      .expect(201);

    expect(await rowsOf(paymentId)).toEqual({ [done]: 100, [proposed]: 50 });
    expect(await queued()).toBe(0);
  });

  it('every mutating route leaves no pending rebalance', async () => {
    const expectDrained = async (label: string) => {
      expect({ label, queued: await queued() }).toEqual({ label, queued: 0 });
    };
    const planId = await createPlan();
    await expectDrained('alta del plan');
    const itemA = await addItem(planId, 100);
    await expectDrained('alta de ítem');
    const itemB = await addItem(planId, 80);
    await setStatus(planId, itemA, 'DONE');
    await expectDrained('ítem realizado');
    await api()
      .patch(`/treatment-plans/${planId}/items/${itemA}`, { price: 90 })
      .expect(200);
    await expectDrained('edición de ítem');
    const paymentId = await pay(planId, 150);
    await expectDrained('abono');
    await api()
      .post(`/treatment-plans/${planId}/items/bulk-discount`, {
        itemIds: [itemA, itemB],
        percent: 10,
      })
      .expect(200);
    await expectDrained('descuento en bloque');
    await api()
      .patch(`/treatment-plans/${planId}/visits`, {
        items: [
          { itemId: itemA, visit: 1 },
          { itemId: itemB, visit: 2 },
        ],
        visitIntervals: { '2': 30 },
      })
      .expect(200);
    await expectDrained('visitas');
    await api().delete(`/treatment-plans/${planId}/items/${itemB}`).expect(200);
    await expectDrained('quitar ítem');
    await api()
      .patch(`/treatment-plans/${planId}`, { notes: 'Plan revisado' })
      .expect(200);
    await expectDrained('edición del plan');
    await api().post(`/treatment-plans/${planId}/present`).expect(200);
    await expectDrained('presentar');
    const alternative = (
      (
        await api()
          .post(`/treatment-plans/${planId}/alternatives`, {
            optionLabel: 'Opción B',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    await expectDrained('alternativa');
    const quote = await api()
      .get(`/patients/${patientId}/treatment-plans/${planId}/quote`)
      .expect(200);
    await api()
      .post(`/patients/${patientId}/treatment-plans/${planId}/acceptance`, {
        signerName: 'Ana Abono',
        signature: SIGNATURE,
        contentHash: (quote.body as { contentHash: string }).contentHash,
      })
      .expect(201);
    await expectDrained('aceptación (la alternativa queda rechazada)');
    expect(
      (
        await raw.treatmentPlan.findUniqueOrThrow({
          where: { id: alternative },
        })
      ).status,
    ).toBe('REJECTED');
    await voidPayment(paymentId);
    await expectDrained('anulación del abono');

    // Cargo por inasistencia (SEC-050) y su anulación.
    const policy = (
      await api()
        .post(`/locations/${locationId}/cancellation-policy`, {
          noticeHours: 24,
          suggestedFee: 30,
          currency: 'EUR',
          patientText: 'Avísanos con 24 h o se cobrará la cita.',
        })
        .expect(201)
    ).body as { id: string };
    const start = new Date(Date.now() - 48 * 3_600_000);
    const appointment = await raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        patientId,
        providerId: randomUUID(),
        start,
        end: new Date(start.getTime() + 30 * 60_000),
        status: 'NO_SHOW',
        noShowMarkedAt: new Date(),
        policyVersionId: policy.id,
      },
    });
    await api()
      .post(`/appointments/${appointment.id}/cancellation-fee`)
      .expect(201);
    await expectDrained('cargo por inasistencia');
    await api()
      .post(`/appointments/${appointment.id}/cancellation-fee/void`, {
        reason: 'Cargo generado por error',
      })
      .expect(201);
    await expectDrained('anulación del cargo');

    // Rechazar un plan (sin abonos: con abonos vivos es un 409) encola por
    // el cambio de estado y no deja cola.
    const rejected = await createPlan();
    await addItem(rejected, 60);
    await api().post(`/treatment-plans/${rejected}/present`).expect(200);
    await api()
      .post(`/treatment-plans/${rejected}/reject`, { reason: 'PRICE' })
      .expect(200);
    await expectDrained('rechazo del plan');
  });

  it('RECEPTION reads per-item balance', async () => {
    const planId = await createPlan();
    const done = await addItem(planId, 100, 'DONE');
    const accepted = await addItem(planId, 50, 'ACCEPTED');
    await pay(planId, 130);
    const teeth = Object.fromEntries(
      (
        await raw.treatmentPlanItem.findMany({
          where: { planId },
          select: { id: true, toothNumber: true },
        })
      ).map((i) => [i.id, i.toothNumber]),
    );
    const reception = await seedMember(raw, clinic, 'RECEPTION');
    const token = await loginAs(app, clinic.host, reception.email);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/treatment-plans/${planId}/balance`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toEqual({
      planCurrency: 'EUR',
      billable: 150,
      paid: 130,
      balance: 20,
      paymentsCount: 1,
      paymentsWithoutRate: [],
      allocated: 130,
      unallocated: 0,
      unconvertedPaymentsCount: 0,
      manualPaymentIds: [],
      items: [
        {
          itemId: done,
          toothNumber: teeth[done],
          procedureName: 'Resina',
          status: 'DONE',
          billable: 100,
          paid: 100,
          balance: 0,
        },
        {
          itemId: accepted,
          toothNumber: teeth[accepted],
          procedureName: 'Resina',
          status: 'ACCEPTED',
          billable: 50,
          paid: 30,
          balance: 20,
        },
      ],
    });
  });

  it.each(['DENTIST', 'ASSISTANT'] as const)(
    '%s gets 403 on balance',
    async (role) => {
      const planId = await createPlan();
      const member = await seedMember(raw, clinic, role);
      const token = await loginAs(app, clinic.host, member.email);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/treatment-plans/${planId}/balance`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      expect(res.body).not.toHaveProperty('items');
    },
  );

  it('item discount after payment moves excess to unallocated', async () => {
    const planId = await createPlan();
    const done = await addItem(planId, 100, 'DONE');
    const paymentId = await pay(planId, 100);
    expect((await fullBalanceOf(planId)).unallocated).toBe(0);

    await api()
      .post(`/treatment-plans/${planId}/items/bulk-discount`, {
        itemIds: [done],
        percent: 10,
      })
      .expect(200);

    const full = await fullBalanceOf(planId);
    expect(full.items[0]).toMatchObject({
      billable: 90,
      paid: 90,
      balance: 0,
    });
    expect(full).toMatchObject({ allocated: 90, unallocated: 10, paid: 100 });
    expect(await rowsOf(paymentId)).toEqual({ [done]: 90 });
  });

  it('opening-balance payments get no base nor allocations', async () => {
    const batch = await raw.patientImportBatch.create({
      data: {
        tenantId: clinic.tenantId,
        createdById: clinic.adminUserId,
        locationId,
        fileName: 'saldos.csv',
        fileSha256: createHash('sha256').update(randomUUID()).digest('hex'),
        fileFormat: 'CSV',
        fileSizeBytes: 10,
        columnMapping: {},
        totalRows: 1,
        validRows: 1,
        duplicateRows: 0,
        errorRows: 0,
        preparedRows: 1,
      },
    });
    const opening = await raw.openingBalance.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        patientId,
        importBatchId: batch.id,
        currency: 'EUR',
        amount: 500,
        asOfDate: new Date(`${EARLIER}T00:00:00.000Z`),
        concept: 'Saldo anterior',
        createdById: clinic.adminUserId,
      },
    });

    const res = await api()
      .post(`/opening-balances/${opening.id}/payments`, {
        amount: 100,
        currency: 'EUR',
        paidAt: RATE_DATE,
        method: 'CASH',
      })
      .expect(201);
    const paymentId = (res.body as { id: string }).id;

    expect(await baseOf(paymentId)).toBeNull();
    expect(await rowsOf(paymentId)).toEqual({});
    expect(await queued()).toBe(0);
  });
});
