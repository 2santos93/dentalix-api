import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  Prisma,
  PrismaClient,
  Sex,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { fixedSedeDay } from './support/sede-clock';
import { pinCatalogCurrency } from './support/catalog-currency';

// DX-570 por HTTP: el vuelto con los mismos permisos que cobrar, sin cruzar
// clínicas por los ids del cuerpo, con la validación de la forma y con la
// Idempotency-Key (la huella incluye el vuelto). El arqueo, la anulación y la
// concurrencia contra Postgres van en cash-change.int-spec.ts.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY = fixedSedeDay(1).day;
const RATE = 36.5;

describe('Vuelto al cobrar en efectivo (e2e, DX-570)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let reception: string;
  let dentist: string;
  let cashA: string;
  let mobileA: string;
  let mobileB: string;
  let planA: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const pay = (
    body: Record<string, unknown>,
    token = reception,
    key?: string,
  ) => {
    const req = as(
      api().post(`/api/v1/treatment-plans/${planA}/payments`),
      a,
      token,
    );
    return (key ? req.set('Idempotency-Key', key) : req).send({
      amount: 45,
      currency: 'USD',
      paidAt: DAY,
      paymentMethodId: cashA,
      tendered: 50,
      ...body,
    });
  };
  const change = (over: Record<string, unknown> = {}) => ({
    paymentMethodId: mobileA,
    currency: 'VES',
    amount: 182.5,
    reference: '0412-5551234',
    ...over,
  });
  const paymentsOfPlan = () =>
    raw.payment.count({ where: { treatmentPlanId: planA } });

  async function mobileOf(clinic: Clinic): Promise<string> {
    return (
      (
        await as(api().post('/api/v1/payment-methods'), clinic)
          .send({
            name: 'Pago móvil',
            kind: 'DIGITAL',
            requiresReference: true,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: DAY, currency: 'VES' },
    });
    await raw.exchangeRateSnapshot.create({
      data: { date: DAY, currency: 'VES', rate: RATE },
    });
    a = await registerClinic(app, 'dx570-e2e-a');
    b = await registerClinic(app, 'dx570-e2e-b');
    reception = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
    dentist = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.DENTIST)).email,
    );
    const methods = (
      await as(api().get('/api/v1/payment-methods'), a).expect(200)
    ).body as { id: string; legacyMethod: string | null }[];
    cashA = methods.find((m) => m.legacyMethod === 'CASH')!.id;
    mobileA = await mobileOf(a);
    mobileB = await mobileOf(b);

    const patient = (
      await as(api().post('/api/v1/patients'), a)
        .send({
          firstName: 'Luis',
          lastName: 'Cambio',
          docType: 'NATIONAL_ID',
          docNumber: 'DX570-E2E',
          sex: Sex.M,
        })
        .expect(201)
    ).body as { id: string };
    await pinCatalogCurrency(raw, a.tenantId, 'USD');
    const item = (
      await as(api().post('/api/v1/catalog/items'), a)
        .send({
          code: 'DX570-E2E',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Resina',
          color: '#2A2B3C',
          defaultPrice: 500,
        })
        .expect(201)
    ).body as { id: string };
    planA = (
      (
        await as(
          api().post(`/api/v1/patients/${patient.id}/treatment-plans`),
          a,
        )
          .send({ notes: 'Plan DX-570 e2e', currency: 'USD' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const planItem = (
      await as(api().post(`/api/v1/treatment-plans/${planA}/items`), a)
        .send({ toothNumber: '21', catalogItemId: item.id })
        .expect(201)
    ).body as { id: string };
    await as(
      api().patch(`/api/v1/treatment-plans/${planA}/items/${planItem.id}`),
      a,
    )
      .send({ status: 'DONE' })
      .expect(200);
  }, 120_000);

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: DAY, currency: 'VES' },
    });
    await app.close();
    await raw.$disconnect();
  });

  it('mismos permisos que cobrar: odontología 403 y no se registra nada; recepción 201', async () => {
    const before = await paymentsOfPlan();
    await pay({ change: [change()] }, dentist).expect(403);
    expect(await paymentsOfPlan()).toBe(before);
    const res = await pay({ change: [change()] }).expect(201);
    expect((res.body as { cashChange: unknown }).cashChange).toMatchObject({
      tendered: 50,
      lines: [{ currency: 'VES', amount: 182.5, equivalentAmount: 5 }],
    });
  });

  it('un medio de otra clínica en el vuelto: 400 y nada insertado (RLS, ids del cuerpo)', async () => {
    const before = await paymentsOfPlan();
    const lines = await raw.paymentChangeLine.count();
    await pay({ change: [change({ paymentMethodId: mobileB })] }).expect(400);
    expect(await paymentsOfPlan()).toBe(before);
    expect(await raw.paymentChangeLine.count()).toBe(lines);
  });

  it('forma del vuelto: id que no es UUID, moneda que no es ISO, más de 3 líneas o importe negativo → 400', async () => {
    const before = await paymentsOfPlan();
    await pay({ change: [change({ paymentMethodId: 'no-es-uuid' })] }).expect(
      400,
    );
    await pay({ change: [change({ currency: 'BOLIVAR' })] }).expect(400);
    await pay({
      change: [change(), change(), change(), change()],
    }).expect(400);
    await pay({ change: [change({ amount: -5 })] }).expect(400);
    await pay({ tendered: 'cincuenta' }).expect(400);
    // Vuelto sin «Recibido».
    await pay({ tendered: undefined, change: [change()] }).expect(400);
    expect(await paymentsOfPlan()).toBe(before);
  });

  it('Idempotency-Key: el mismo cobro con vuelto devuelve el original; otro vuelto con la misma clave es 422', async () => {
    const key = randomUUID();
    const first = await pay({ change: [change()] }, reception, key).expect(201);
    const replay = await pay({ change: [change()] }, reception, key).expect(
      201,
    );
    expect((replay.body as { id: string }).id).toBe(
      (first.body as { id: string }).id,
    );
    expect((replay.body as { cashChange: unknown }).cashChange).toEqual(
      (first.body as { cashChange: unknown }).cashChange,
    );
    await pay(
      { change: [change({ amount: 100 })], changeRemainderToCredit: true },
      reception,
      key,
    ).expect(422);
  });

  it('GET del abono y la lista del plan devuelven el vuelto', async () => {
    const created = (await pay({ change: [change()] }).expect(201)).body as {
      id: string;
    };
    const list = (
      await as(
        api().get(`/api/v1/treatment-plans/${planA}/payments`),
        a,
      ).expect(200)
    ).body as { id: string; cashChange: { tendered: number } | null }[];
    expect(list.find((p) => p.id === created.id)?.cashChange?.tendered).toBe(
      50,
    );
  });

  describe('el vuelto solo en el abono suelto a un plan: en el resto, 400 en español y nada registrado', () => {
    const MESSAGE =
      'El vuelto solo se registra en un abono suelto en efectivo a un plan de tratamiento.';
    const messagesOf = (body: unknown) => JSON.stringify(body);

    it('cobro dividido con «Recibido» o vuelto (en el cobro o en una línea) → 400', async () => {
      const before = await paymentsOfPlan();
      const lines = [
        { amount: 20, currency: 'USD', paymentMethodId: cashA },
        {
          amount: 182.5,
          currency: 'VES',
          paymentMethodId: mobileA,
          reference: 'S-1',
        },
      ];
      for (const body of [
        { paidAt: DAY, lines, tendered: 50 },
        { paidAt: DAY, lines, change: [change()] },
        { paidAt: DAY, lines, changeRemainderToCredit: true },
        {
          paidAt: DAY,
          lines: [{ ...lines[0], tendered: 25 }, lines[1]],
        },
      ]) {
        const res = await as(
          api().post(`/api/v1/treatment-plans/${planA}/split-payments`),
          a,
          reception,
        )
          .send(body)
          .expect(400);
        expect(messagesOf(res.body)).toContain(MESSAGE);
      }
      expect(await paymentsOfPlan()).toBe(before);
    });

    it('abono al saldo migrado con «Recibido» o vuelto → 400', async () => {
      const patient = await raw.patient.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      });
      const location = await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      });
      const batch = await raw.patientImportBatch.create({
        data: {
          tenantId: a.tenantId,
          createdById: a.adminUserId,
          locationId: location.id,
          fileName: 'saldos.csv',
          fileSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
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
          tenantId: a.tenantId,
          locationId: location.id,
          patientId: patient.id,
          importBatchId: batch.id,
          currency: 'USD',
          amount: new Prisma.Decimal('300.00'),
          asOfDate: new Date('2026-03-15T00:00:00.000Z'),
          concept: 'Ortodoncia 2025',
          createdById: a.adminUserId,
        },
      });
      for (const extra of [
        { tendered: 50 },
        { tendered: 50, change: [change()] },
        { changeRemainderToCredit: true },
      ]) {
        const res = await as(
          api().post(`/api/v1/opening-balances/${opening.id}/payments`),
          a,
          reception,
        )
          .send({
            amount: 45,
            currency: 'USD',
            paidAt: DAY,
            paymentMethodId: cashA,
            ...extra,
          })
          .expect(400);
        expect(messagesOf(res.body)).toContain(MESSAGE);
      }
      expect(
        await raw.payment.count({ where: { openingBalanceId: opening.id } }),
      ).toBe(0);
      // Sin vuelto, el abono al saldo migrado sigue como siempre.
      await as(
        api().post(`/api/v1/opening-balances/${opening.id}/payments`),
        a,
        reception,
      )
        .send({
          amount: 45,
          currency: 'USD',
          paidAt: DAY,
          paymentMethodId: cashA,
        })
        .expect(201);
    });
  });
});
