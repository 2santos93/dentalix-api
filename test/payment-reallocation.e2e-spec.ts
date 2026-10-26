import { createHash, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
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

// DX-051 Task 5 por HTTP: un ADMIN fija a mano a qué ítems va un abono
// (MANUAL) o lo devuelve al reparto (AUTO); cada error de spec §5.3 con su
// mensaje exacto; roles, auditoría y aislamiento. Tasa EUR del día sembrada
// (1 USD = 0,9 EUR); GBP no tiene tasa ese día hasta que un test la siembra.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const RATE_DATE = '2026-07-01';
const EARLIER = '2026-06-15';
const TEETH = [11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28];
let toothSeq = 0;

interface Line {
  treatmentPlanItemId: string;
  amount: number;
  source?: 'AUTO' | 'MANUAL';
}

interface Allocations {
  paymentId: string;
  receiptNumber: string | null;
  treatmentPlanId: string;
  paymentAmount: number;
  paymentCurrency: string;
  paidOn: string;
  planCurrency: string;
  planStatus: string;
  planAmount: number | null;
  manual: boolean;
  allocated: number;
  unallocated: number | null;
  version: string;
  allocations: Line[];
  items: {
    itemId: string;
    status: string;
    billable: number;
    paidByOthers: number;
    free: number;
  }[];
  previous?: { treatmentPlanItemId: string; amount: number }[];
}

describe('Reasignación de la imputación de un abono (DX-051, e2e)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let patientId: string;
  let catalogItemId: string;
  let locationId: string;
  const tokens: Partial<Record<ClinicRole, string>> = {};

  const api = (token = clinic.adminToken, host = clinic.host) => {
    const server = app.getHttpServer();
    const auth = (t: request.Test) =>
      t.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
    return {
      get: (path: string) => auth(request(server).get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        auth(request(server).post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) =>
        auth(request(server).patch(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        auth(request(server).put(`/api/v1${path}`)).send(body),
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
    status: 'PROPOSED' | 'ACCEPTED' | 'DONE' = 'ACCEPTED',
  ): Promise<string> {
    const res = await api()
      .post(`/treatment-plans/${planId}/items`, {
        toothNumber: String(TEETH[toothSeq++ % TEETH.length]),
        catalogItemId,
        price,
      })
      .expect(201);
    const itemId = (res.body as { id: string }).id;
    if (status !== 'PROPOSED') {
      await api()
        .patch(`/treatment-plans/${planId}/items/${itemId}`, { status })
        .expect(200);
    }
    return itemId;
  }

  async function pay(
    planId: string,
    amount: number,
    opts: { currency?: string; paidAt?: string } = {},
  ): Promise<string> {
    const res = await api()
      .post(`/treatment-plans/${planId}/payments`, {
        amount,
        currency: opts.currency ?? 'EUR',
        paidAt: opts.paidAt ?? RATE_DATE,
        method: 'TRANSFER',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function allocationsOf(paymentId: string): Promise<Allocations> {
    const res = await api()
      .get(`/payments/${paymentId}/allocations`)
      .expect(200);
    return res.body as Allocations;
  }

  /**
   * PUT con la versión recién leída (salvo que se pase otra); comprueba el
   * código HTTP.
   */
  async function put(
    paymentId: string,
    body: { mode: 'MANUAL' | 'AUTO'; allocations?: unknown[] },
    status: number,
    expectedVersion?: string,
  ): Promise<request.Response> {
    const version = expectedVersion ?? (await allocationsOf(paymentId)).version;
    return api()
      .put(`/payments/${paymentId}/allocations`, {
        expectedVersion: version,
        ...body,
      })
      .expect(status);
  }

  const line = (treatmentPlanItemId: string, amount: number) => ({
    treatmentPlanItemId,
    amount,
  });

  /** Céntimos imputados por ítem de un abono (filas vivas). */
  async function rowsOf(paymentId: string): Promise<Record<string, number>> {
    const rows = await raw.paymentAllocation.findMany({ where: { paymentId } });
    return Object.fromEntries(
      rows.map((r) => [r.treatmentPlanItemId, Number(r.amount)]),
    );
  }

  /** El mensaje de un error de validación del DTO (lista de un elemento). */
  const dtoMessage = (res: request.Response): unknown =>
    (res.body as { message: unknown }).message;
  /** El mensaje de un error del caso de uso (texto). */
  const message = (res: request.Response): unknown =>
    (res.body as { message: unknown }).message;

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({ where: { date: RATE_DATE } });
    await raw.exchangeRateSnapshot.create({
      data: { date: RATE_DATE, currency: 'EUR', rate: 0.9 },
    });
    clinic = await registerClinic(app, 'dx051-realloc');
    other = await registerClinic(app, 'dx051-realloc-b');
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
            defaultPrice: 1,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    for (const role of [
      ClinicRole.RECEPTION,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({ where: { date: RATE_DATE } });
    await app.close();
    await raw.$disconnect();
  });

  it('MANUAL moves an allocation between items and pins the payment', async () => {
    const planId = await createPlan();
    const done = await addItem(planId, 100, 'DONE');
    const accepted = await addItem(planId, 100);
    const paymentId = await pay(planId, 100);
    const before = await allocationsOf(paymentId);
    expect(before).toMatchObject({
      manual: false,
      allocated: 100,
      unallocated: 0,
      allocations: [{ treatmentPlanItemId: done, amount: 100, source: 'AUTO' }],
    });
    expect(before.receiptNumber).toMatch(/^[A-Z][A-Z0-9]{1,5}-\d{6,}$/);

    const res = await put(
      paymentId,
      {
        mode: 'MANUAL',
        allocations: [line(accepted, 60), line(done, 40)],
      },
      200,
    );

    const body = res.body as Allocations;
    expect(body).toMatchObject({
      paymentId,
      receiptNumber: before.receiptNumber,
      manual: true,
      planStatus: 'DRAFT',
      planAmount: 100,
      allocated: 100,
      unallocated: 0,
      previous: [{ treatmentPlanItemId: done, amount: 100 }],
    });
    expect(body.allocations).toEqual([
      { treatmentPlanItemId: done, amount: 40, source: 'MANUAL' },
      { treatmentPlanItemId: accepted, amount: 60, source: 'MANUAL' },
    ]);
    expect(body.version).not.toBe(before.version);
    expect(await rowsOf(paymentId)).toEqual({ [done]: 40, [accepted]: 60 });
    // Historial con la causa MANUAL: −100 en el realizado, +40 y +60.
    const movements = await raw.paymentAllocationMovement.findMany({
      where: { paymentId, cause: 'MANUAL' },
    });
    expect(
      movements.map((m) => Number(m.deltaCents)).sort((a, b) => a - b),
    ).toEqual([-10_000, 4_000, 6_000]);
    // La marca «Fijada a mano» del plan.
    const balance = await api()
      .get(`/treatment-plans/${planId}/balance`)
      .expect(200);
    expect(
      (balance.body as { manualPaymentIds: string[] }).manualPaymentIds,
    ).toEqual([paymentId]);
  });

  it('manual empty allocation stays unallocated after respread', async () => {
    const planId = await createPlan();
    const done = await addItem(planId, 100, 'DONE');
    const paymentId = await pay(planId, 100);

    const res = await put(paymentId, { mode: 'MANUAL', allocations: [] }, 200);
    expect(res.body as Allocations).toMatchObject({
      manual: true,
      allocated: 0,
      unallocated: 100,
      allocations: [],
      previous: [{ treatmentPlanItemId: done, amount: 100 }],
    });

    // Aparece más saldo por cubrir y el plan se reparte: el abono fijado no
    // vuelve a llenarse.
    await addItem(planId, 50, 'DONE');
    await api()
      .patch(`/treatment-plans/${planId}/items/${done}`, { price: 120 })
      .expect(200);
    expect(await rowsOf(paymentId)).toEqual({});
    expect(
      await raw.planAllocationRebalanceRequest.count({
        where: { treatmentPlanId: planId },
      }),
    ).toBe(0);
    expect((await allocationsOf(paymentId)).unallocated).toBe(100);
  });

  it('AUTO unpins and fills only free items in R5 order', async () => {
    const planId = await createPlan();
    const done = await addItem(planId, 100, 'DONE');
    const accepted = await addItem(planId, 100);
    const older = await pay(planId, 100, { paidAt: EARLIER });
    await put(
      older,
      {
        mode: 'MANUAL',
        allocations: [line(accepted, 100)],
      },
      200,
    );
    // Uno más reciente llena lo libre: el realizado.
    const newer = await pay(planId, 100);
    expect(await rowsOf(newer)).toEqual({ [done]: 100 });

    const res = await put(older, { mode: 'AUTO' }, 200);

    // Vuelve en su puesto (el más antiguo) pero solo llena lo libre: el
    // aceptado. No se le devuelve el realizado que ya cubre el otro abono.
    expect(res.body as Allocations).toMatchObject({
      manual: false,
      allocated: 100,
      unallocated: 0,
      allocations: [
        { treatmentPlanItemId: accepted, amount: 100, source: 'AUTO' },
      ],
      previous: [{ treatmentPlanItemId: accepted, amount: 100 }],
    });
    expect(await rowsOf(newer)).toEqual({ [done]: 100 });
    const balance = await api()
      .get(`/treatment-plans/${planId}/balance`)
      .expect(200);
    expect(
      (balance.body as { manualPaymentIds: string[] }).manualPaymentIds,
    ).toEqual([]);
  });

  it("freed balance from a manual move is filled by other payments' surplus", async () => {
    const planId = await createPlan();
    const done = await addItem(planId, 100, 'DONE');
    const accepted = await addItem(planId, 100);
    const pinned = await pay(planId, 100, { paidAt: EARLIER });
    const donor = await pay(planId, 150);
    expect(await rowsOf(pinned)).toEqual({ [done]: 100 });
    expect(await rowsOf(donor)).toEqual({ [accepted]: 100 });

    const res = await put(
      pinned,
      {
        mode: 'MANUAL',
        allocations: [line(done, 40)],
      },
      200,
    );

    // Los 60 que deja libres los llena el sobrante (50) del otro abono.
    expect(await rowsOf(donor)).toEqual({ [accepted]: 100, [done]: 50 });
    const body = res.body as Allocations;
    expect(body.allocations).toEqual([
      { treatmentPlanItemId: done, amount: 40, source: 'MANUAL' },
    ]);
    expect(body.items.find((i) => i.itemId === done)).toMatchObject({
      billable: 100,
      paidByOthers: 50,
      free: 50,
    });
  });

  it('a legacy payment without base gets it on PUT once there is a rate', async () => {
    const planId = await createPlan();
    const done = await addItem(planId, 100, 'DONE');
    const paymentId = await pay(planId, 50, { currency: 'GBP' });
    const before = await allocationsOf(paymentId);
    expect(before).toMatchObject({ planAmount: null, unallocated: null });

    await raw.exchangeRateSnapshot.create({
      data: { date: RATE_DATE, currency: 'GBP', rate: 0.8 },
    });
    try {
      const res = await put(paymentId, { mode: 'AUTO' }, 200, before.version);
      // 50 GBP a 0,8 GBP por USD y 0,9 EUR por USD: 56,25 EUR.
      expect(res.body as Allocations).toMatchObject({
        planAmount: 56.25,
        allocated: 56.25,
        allocations: [
          { treatmentPlanItemId: done, amount: 56.25, source: 'AUTO' },
        ],
      });
    } finally {
      await raw.exchangeRateSnapshot.deleteMany({
        where: { date: RATE_DATE, currency: 'GBP' },
      });
    }
  });

  describe('errores de spec §5.3, con su mensaje exacto', () => {
    let planId: string;
    let done: string;
    let accepted: string;
    let proposed: string;
    let paymentId: string;

    beforeAll(async () => {
      planId = await createPlan();
      done = await addItem(planId, 100, 'DONE');
      accepted = await addItem(planId, 100);
      proposed = await addItem(planId, 100, 'PROPOSED');
      paymentId = await pay(planId, 100);
      // Otro abono cubre 70 del aceptado: a este le quedan 30 ahí.
      const otherPayment = await pay(planId, 70);
      await put(
        otherPayment,
        {
          mode: 'MANUAL',
          allocations: [line(accepted, 70)],
        },
        200,
      );
    });

    it('unknown and voided payments: 404', async () => {
      const unknown = await api()
        .get(`/payments/${randomUUID()}/allocations`)
        .expect(404);
      expect(message(unknown)).toBe('Abono no encontrado.');

      const voidedPlan = await createPlan();
      await addItem(voidedPlan, 100, 'DONE');
      const voided = await pay(voidedPlan, 10);
      const version = (await allocationsOf(voided)).version;
      await api()
        .delete(`/payments/${voided}`, { reason: 'Registrado por error' })
        .expect(200);
      const get = await api()
        .get(`/payments/${voided}/allocations`)
        .expect(404);
      expect(message(get)).toBe('Abono no encontrado.');
      const res = await put(voided, { mode: 'AUTO' }, 404, version);
      expect(message(res)).toBe('Abono no encontrado.');
    });

    it('opening-balance payment: 409', async () => {
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
      const created = await api()
        .post(`/opening-balances/${opening.id}/payments`, {
          amount: 100,
          currency: 'EUR',
          paidAt: RATE_DATE,
          method: 'CASH',
        })
        .expect(201);
      const migrated = (created.body as { id: string }).id;
      const msg =
        'Este abono es de un saldo migrado: no se imputa a ítems de un plan.';

      expect(
        message(
          await api().get(`/payments/${migrated}/allocations`).expect(409),
        ),
      ).toBe(msg);
      expect(
        message(await put(migrated, { mode: 'AUTO' }, 409, 'a'.repeat(64))),
      ).toBe(msg);
    });

    it('cancelled plan: 409', async () => {
      const cancelledPlan = await createPlan();
      await addItem(cancelledPlan, 100, 'DONE');
      const cancelledPayment = await pay(cancelledPlan, 50);
      const version = (await allocationsOf(cancelledPayment)).version;
      await api()
        .patch(`/treatment-plans/${cancelledPlan}`, { status: 'CANCELLED' })
        .expect(200);
      // La lectura sigue: dice el estado y no ofrece ítems (m2).
      expect(await allocationsOf(cancelledPayment)).toMatchObject({
        planStatus: 'CANCELLED',
        items: [],
        allocations: [],
      });

      const res = await put(
        cancelledPayment,
        { mode: 'MANUAL', allocations: [] },
        409,
        version,
      );
      expect(message(res)).toBe(
        'El plan está «Cancelado»: sus abonos no se imputan a ítems.',
      );
    });

    it('no rate for the payment date: 409', async () => {
      const gbp = await pay(planId, 10, { currency: 'GBP' });
      const res = await put(gbp, { mode: 'AUTO' }, 409);
      expect(message(res)).toBe(
        `No hay tasa de cambio de GBP a EUR para el ${RATE_DATE}: este abono no se puede imputar todavía.`,
      );
      expect(
        await raw.paymentPlanAmount.count({ where: { paymentId: gbp } }),
      ).toBe(0);
    });

    it('stale expectedVersion returns 409', async () => {
      const version = (await allocationsOf(paymentId)).version;
      await put(
        paymentId,
        {
          mode: 'MANUAL',
          allocations: [line(done, 90)],
        },
        200,
      );

      const res = await put(
        paymentId,
        { mode: 'MANUAL', allocations: [line(done, 80)] },
        409,
        version,
      );
      expect(message(res)).toBe(
        'La imputación de este abono cambió mientras la editabas. Revisa los importes y vuelve a guardar.',
      );
      expect(await rowsOf(paymentId)).toEqual({ [done]: 90 });
    });

    it('amount ≤ 0 or with 3 decimals: 400', async () => {
      for (const amount of [0, -5, 10.005]) {
        const res = await put(
          paymentId,
          {
            mode: 'MANUAL',
            allocations: [line(done, amount)],
          },
          400,
        );
        expect(dtoMessage(res)).toEqual([
          'Cada importe debe ser mayor que 0 y tener como máximo 2 decimales.',
        ]);
      }
    });

    it('repeated item: 400', async () => {
      const res = await put(
        paymentId,
        {
          mode: 'MANUAL',
          allocations: [line(done, 10), line(done, 20)],
        },
        400,
      );
      expect(message(res)).toBe('Cada ítem puede aparecer una sola vez.');
    });

    it('more than 200 lines: 400', async () => {
      const res = await put(
        paymentId,
        {
          mode: 'MANUAL',
          allocations: Array.from({ length: 201 }, () => line(randomUUID(), 1)),
        },
        400,
      );
      expect(dtoMessage(res)).toEqual(['Como máximo 200 ítems por abono.']);
    });

    it('allocations with AUTO, or none with MANUAL: 400', async () => {
      const msg =
        'Con el reparto automático no se envían importes; con el manual, sí.';
      expect(
        dtoMessage(
          await put(
            paymentId,
            {
              mode: 'AUTO',
              allocations: [line(done, 10)],
            },
            400,
          ),
        ),
      ).toEqual([msg]);
      expect(dtoMessage(await put(paymentId, { mode: 'MANUAL' }, 400))).toEqual(
        [msg],
      );
    });

    it('item of another plan or unknown: 400', async () => {
      const otherPlan = await createPlan();
      const foreignItem = await addItem(otherPlan, 100, 'DONE');
      for (const itemId of [foreignItem, randomUUID()]) {
        const res = await put(
          paymentId,
          {
            mode: 'MANUAL',
            allocations: [line(itemId, 10)],
          },
          400,
        );
        expect(message(res)).toBe('El ítem no es de este plan o ya no existe.');
      }
    });

    it('PROPOSED item: 400', async () => {
      const res = await put(
        paymentId,
        {
          mode: 'MANUAL',
          allocations: [line(proposed, 10)],
        },
        400,
      );
      expect(message(res)).toBe(
        'Solo se imputa a ítems aceptados o realizados.',
      );
    });

    it('line over what is free: 400', async () => {
      const res = await put(
        paymentId,
        {
          mode: 'MANUAL',
          allocations: [line(accepted, 30.01)],
        },
        400,
      );
      expect(message(res)).toBe(
        'Un ítem admite como máximo 30.00 EUR: es lo que le queda por cubrir.',
      );
    });

    it('over the converted payment amount (USD payment)', async () => {
      const usdPlan = await createPlan();
      const first = await addItem(usdPlan, 100, 'DONE');
      const second = await addItem(usdPlan, 100);
      // 100 USD a 0,9: 90 EUR de base.
      const usd = await pay(usdPlan, 100, { currency: 'USD' });
      expect((await allocationsOf(usd)).planAmount).toBe(90);

      const res = await put(
        usd,
        {
          mode: 'MANUAL',
          allocations: [line(first, 50), line(second, 40.01)],
        },
        400,
      );
      expect(message(res)).toBe(
        'La suma imputada (90.01 EUR) supera el abono convertido a la moneda del plan (90.00 EUR).',
      );
      await put(
        usd,
        {
          mode: 'MANUAL',
          allocations: [line(first, 50), line(second, 40)],
        },
        200,
      );
    });
  });

  describe('roles', () => {
    let paymentId: string;

    beforeAll(async () => {
      const planId = await createPlan();
      await addItem(planId, 100, 'DONE');
      paymentId = await pay(planId, 50);
    });

    it('RECEPTION can read allocations but PUT is 403', async () => {
      const token = tokens.RECEPTION as string;
      const read = await api(token)
        .get(`/payments/${paymentId}/allocations`)
        .expect(200);
      await api(token)
        .put(`/payments/${paymentId}/allocations`, {
          expectedVersion: (read.body as Allocations).version,
          mode: 'AUTO',
        })
        .expect(403);
    });

    it('DENTIST and ASSISTANT get 403 on both', async () => {
      const version = (await allocationsOf(paymentId)).version;
      for (const role of [ClinicRole.DENTIST, ClinicRole.ASSISTANT]) {
        const token = tokens[role] as string;
        await api(token).get(`/payments/${paymentId}/allocations`).expect(403);
        await api(token)
          .put(`/payments/${paymentId}/allocations`, {
            expectedVersion: version,
            mode: 'AUTO',
          })
          .expect(403);
      }
    });
  });

  it('audit records PAYMENT_ALLOCATION with mode, before and after', async () => {
    const planId = await createPlan();
    const done = await addItem(planId, 100, 'DONE');
    const accepted = await addItem(planId, 100);
    const paymentId = await pay(planId, 100);

    await put(
      paymentId,
      {
        mode: 'MANUAL',
        allocations: [line(accepted, 25.5)],
      },
      200,
    );
    await put(paymentId, { mode: 'AUTO' }, 200);

    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        resourceType: 'PAYMENT_ALLOCATION',
        resourceId: paymentId,
      },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events).toHaveLength(2);
    expect(events.map((e) => [e.action, e.actorUserId, e.patientId])).toEqual([
      ['UPDATE', clinic.adminUserId, patientId],
      ['UPDATE', clinic.adminUserId, patientId],
    ]);
    expect(events.map((e) => e.metadata)).toEqual([
      expect.objectContaining({
        reason: 'PAYMENT_REALLOCATED',
        allocation: {
          currency: 'EUR',
          mode: 'MANUAL',
          before: [{ itemId: done, amount: 100 }],
          after: [{ itemId: accepted, amount: 25.5 }],
        },
      }),
      expect.objectContaining({
        reason: 'PAYMENT_REALLOCATED',
        allocation: {
          currency: 'EUR',
          mode: 'AUTO',
          before: [{ itemId: accepted, amount: 25.5 }],
          after: [{ itemId: done, amount: 100 }],
        },
      }),
    ]);
  });

  it('isolation: routes of A from B are 404; a PUT of B with an item of A is 400', async () => {
    const planA = await createPlan();
    const itemA = await addItem(planA, 100, 'DONE');
    const paymentA = await pay(planA, 50);
    const versionA = (await allocationsOf(paymentA)).version;
    const before = await rowsOf(paymentA);

    const b = api(other.adminToken, other.host);
    expect(
      message(await b.get(`/payments/${paymentA}/allocations`).expect(404)),
    ).toBe('Abono no encontrado.');
    expect(
      message(
        await b
          .put(`/payments/${paymentA}/allocations`, {
            expectedVersion: versionA,
            mode: 'MANUAL',
            allocations: [line(itemA, 10)],
          })
          .expect(404),
      ),
    ).toBe('Abono no encontrado.');

    // B con su propio abono y un ítem de A en el cuerpo.
    const patientB = (
      await raw.patient.create({
        data: { tenantId: other.tenantId, firstName: 'Bea', lastName: 'B' },
      })
    ).id;
    const planB = (
      (
        await b
          .post(`/patients/${patientB}/treatment-plans`, { currency: 'EUR' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const paymentB = (
      (
        await b
          .post(`/treatment-plans/${planB}/payments`, {
            amount: 30,
            currency: 'EUR',
            paidAt: RATE_DATE,
            method: 'CASH',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    const versionB = (
      (await b.get(`/payments/${paymentB}/allocations`).expect(200))
        .body as Allocations
    ).version;
    const res = await b
      .put(`/payments/${paymentB}/allocations`, {
        expectedVersion: versionB,
        mode: 'MANUAL',
        allocations: [line(itemA, 10)],
      })
      .expect(400);
    expect(message(res)).toBe('El ítem no es de este plan o ya no existe.');
    expect(await rowsOf(paymentA)).toEqual(before);
  });
});
