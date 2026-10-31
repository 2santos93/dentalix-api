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
import { civilDateIn } from '../src/shared/time/civil-day';

// DX-253 en HTTP real: un plan CANCELADO con 300.000 abonados traspasa 200.000
// a un plan vivo del mismo paciente (el origen queda con 100.000 a favor, el
// destino baja 200.000 y los abonos no cambian); la devolución valida importe,
// moneda, motivo y abonos (400 sin guardar nada), exige caja abierta si la
// clínica lo pide (409), en efectivo es un egreso del arqueo (DX-027) y lleva
// un comprobante numerado por sede; dos devoluciones a la vez: una 201 y otra
// 409; RECEPTION por encima del tope, 403; DENTIST/ASSISTANT, 403; otra
// clínica, 404; Idempotency-Key en las dos escrituras.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const ZONE = 'America/Bogota';
const TODAY = civilDateIn(new Date(), ZONE);

interface TransferBody {
  id: string;
  sourcePlanId: string;
  targetPlanId: string;
  amount: number;
  sourceCreditAfter: number;
}

interface RefundBody {
  id: string;
  number: string;
  amount: number;
  method: string;
  cashSessionId: string | null;
  paymentIds: string[];
  snapshot: {
    number: string;
    patient: { fullName: string };
    amount: number;
    method: string;
    reason: string;
    payments: { id: string; receiptNumber: string }[];
    creditBefore: number;
    creditAfter: number;
  };
}

interface PlanLine {
  id: string;
  paid: number;
  creditMovements: number;
  balance: number;
}

describe('Saldo a favor: traspaso y devolución (e2e, DX-253)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let receptionA: string;
  let dentistA: string;
  let assistantA: string;
  let sede: string;
  let patientId: string;
  let origin: string;
  let target: string;
  let otherPlan: string;
  let originPayment: string;
  let otherPayment: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token = clinic.adminToken) => {
    const withAuth = req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
    // La sede de A (la de la caja y la serie del comprobante).
    return clinic === a && sede
      ? withAuth.set('X-Location-Id', sede)
      : withAuth;
  };
  const transfer = (
    body: Record<string, unknown>,
    { token = a.adminToken, key }: { token?: string; key?: string } = {},
  ) => {
    const req = as(
      api().post(`/api/v1/treatment-plans/${origin}/credit-transfers`),
      a,
      token,
    );
    return (key ? req.set('Idempotency-Key', key) : req).send(body);
  };
  const refund = (
    body: Record<string, unknown>,
    { token = a.adminToken, key }: { token?: string; key?: string } = {},
  ) => {
    const req = as(
      api().post(`/api/v1/treatment-plans/${origin}/credit-refunds`),
      a,
      token,
    );
    return (key ? req.set('Idempotency-Key', key) : req).send({
      currency: 'COP',
      method: 'CASH',
      reason: 'El paciente se muda de ciudad',
      paymentIds: [originPayment],
      ...body,
    });
  };
  const counts = async () => ({
    transfers: await raw.patientCreditTransfer.count({
      where: { tenantId: a.tenantId },
    }),
    refunds: await raw.patientCreditRefund.count({
      where: { tenantId: a.tenantId },
    }),
    entries: await raw.patientCreditEntry.count({
      where: { tenantId: a.tenantId },
    }),
  });
  const planLines = async (): Promise<PlanLine[]> =>
    (
      (
        await as(
          api().get(`/api/v1/patients/${patientId}/account-statement`),
          a,
        ).expect(200)
      ).body as { plans: PlanLine[] }
    ).plans;

  async function seedPlan(price: number, tag: string): Promise<string> {
    const item = (
      await as(api().post('/api/v1/catalog/items'), a)
        .send({
          code: `DX253-${tag}`,
          kind: CatalogKind.PROCEDURE,
          labelEs: `Corona ${tag}`,
          color: '#2A2B3C',
          defaultPrice: price,
        })
        .expect(201)
    ).body as { id: string };
    const planId = (
      (
        await as(api().post(`/api/v1/patients/${patientId}/treatment-plans`), a)
          .send({ notes: `Plan ${tag}`, currency: 'COP' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const planItem = (
      await as(api().post(`/api/v1/treatment-plans/${planId}/items`), a)
        .send({ toothNumber: '11', catalogItemId: item.id })
        .expect(201)
    ).body as { id: string };
    await as(
      api().patch(`/api/v1/treatment-plans/${planId}/items/${planItem.id}`),
      a,
    )
      .send({ status: 'DONE' })
      .expect(200);
    return planId;
  }

  async function pay(planId: string, amount: number): Promise<string> {
    return (
      (
        await as(api().post(`/api/v1/treatment-plans/${planId}/payments`), a)
          .send({ amount, currency: 'COP', paidAt: TODAY, method: 'TRANSFER' })
          .expect(201)
      ).body as { id: string }
    ).id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx253-a');
    b = await registerClinic(app, 'dx253-b');
    sede = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      })
    ).id;
    receptionA = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
    dentistA = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.DENTIST)).email,
    );
    assistantA = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.ASSISTANT)).email,
    );
    patientId = (
      (
        await as(api().post('/api/v1/patients'), a)
          .send({
            firstName: 'Ana',
            lastName: 'Favor',
            docType: 'NATIONAL_ID',
            docNumber: 'DX253-1',
            sex: Sex.F,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    origin = await seedPlan(500_000, 'ORIGEN');
    target = await seedPlan(400_000, 'DESTINO');
    otherPlan = await seedPlan(100_000, 'OTRO');
    originPayment = await pay(origin, 300_000);
    otherPayment = await pay(otherPlan, 10_000);
    await as(api().patch(`/api/v1/treatment-plans/${origin}`), a)
      .send({ status: 'CANCELLED' })
      .expect(200);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('DENTIST y ASSISTANT: 403 en español (API)', async () => {
    for (const token of [dentistA, assistantA]) {
      const res = await transfer(
        { targetPlanId: target, amount: 1, currency: 'COP' },
        { token },
      ).expect(403);
      expect((res.body as { message: string }).message).toMatch(
        /saldo a favor/,
      );
      await refund({ amount: 1 }, { token }).expect(403);
    }
  });

  it('RECEPTION con el tope por defecto (0): 403 en español y nada guardado', async () => {
    const res = await transfer(
      { targetPlanId: target, amount: 1_000, currency: 'COP' },
      { token: receptionA },
    ).expect(403);
    expect((res.body as { message: string }).message).toMatch(
      /Recepción no puede/,
    );
    expect(await counts()).toEqual({ transfers: 0, refunds: 0, entries: 0 });
  });

  it('traspasa 200.000 del plan cancelado a un plan vivo: origen 100.000 a favor, destino −200.000, abonos intactos; Idempotency-Key', async () => {
    const key = randomUUID();
    const body = { targetPlanId: target, amount: 200_000, currency: 'COP' };
    const first = (await transfer(body, { key }).expect(201))
      .body as TransferBody;
    expect(first).toMatchObject({
      sourcePlanId: origin,
      targetPlanId: target,
      amount: 200_000,
      sourceCreditAfter: 100_000,
    });
    const again = (await transfer(body, { key }).expect(201))
      .body as TransferBody;
    expect(again.id).toBe(first.id);
    await transfer({ ...body, amount: 1 }, { key }).expect(422);
    expect(await counts()).toEqual({ transfers: 1, refunds: 0, entries: 2 });

    const lines = await planLines();
    expect(lines.find((p) => p.id === origin)).toMatchObject({
      paid: 300_000,
      creditMovements: -200_000,
      balance: -100_000,
    });
    expect(lines.find((p) => p.id === target)).toMatchObject({
      paid: 0,
      creditMovements: 200_000,
      balance: 200_000,
    });
    const balance = (
      await as(
        api().get(`/api/v1/treatment-plans/${target}/balance`),
        a,
      ).expect(200)
    ).body as { balance: number; creditMovements: number };
    expect(balance).toMatchObject({
      creditMovements: 200_000,
      balance: 200_000,
    });
    const payment = await raw.payment.findUniqueOrThrow({
      where: { id: originPayment },
      select: { amount: true, deletedAt: true, treatmentPlanId: true },
    });
    expect(payment.amount.toNumber()).toBe(300_000);
    expect(payment.deletedAt).toBeNull();
    expect(payment.treatmentPlanId).toBe(origin);
  });

  it('traspaso a un plan cancelado (409) o más que el saldo (400)', async () => {
    await transfer({
      targetPlanId: target,
      amount: 100_000.01,
      currency: 'COP',
    }).expect(400);
    await as(
      api().post(`/api/v1/treatment-plans/${target}/credit-transfers`),
      a,
    )
      .send({ targetPlanId: origin, amount: 1, currency: 'COP' })
      .expect(409);
  });

  it('devolver más que el saldo, en otra moneda, sin motivo o con un abono de otro plan: 400 en español sin guardar nada', async () => {
    const before = await counts();
    const cases: Record<string, unknown>[] = [
      { amount: 100_000.01 },
      { amount: 1_000, currency: 'USD' },
      { amount: 1_000, reason: '' },
      { amount: 1_000, reason: undefined },
      { amount: 1_000, paymentIds: [] },
      { amount: 1_000, paymentIds: [otherPayment] },
    ];
    for (const body of cases) {
      const res = await refund(body).expect(400);
      expect(JSON.stringify(res.body)).toMatch(
        /saldo a favor|moneda|motivo|abono/,
      );
    }
    expect(await counts()).toEqual(before);
  });

  it('con «exigir caja abierta» y sin caja, la devolución en efectivo es 409', async () => {
    await as(api().put('/api/v1/cash-sessions/settings'), a)
      .send({ requireOpenSession: true, blindClose: false })
      .expect(200);
    const res = await refund({ amount: 1_000 }).expect(409);
    expect((res.body as { message: string }).message).toMatch(/caja abierta/);
  });

  it('en efectivo con caja abierta es un egreso del arqueo y sale en el detalle; comprobante numerado', async () => {
    const session = (
      await as(api().post('/api/v1/cash-sessions/open'), a)
        .send({ floats: [{ currency: 'COP', amount: 50_000 }] })
        .expect(201)
    ).body as { id: string };
    const key = randomUUID();
    const res = (await refund({ amount: 40_000 }, { key }).expect(201))
      .body as RefundBody;
    expect(res.number).toMatch(/^DEV-[A-Z0-9]+-000001$/);
    expect(res).toMatchObject({
      amount: 40_000,
      method: 'CASH',
      cashSessionId: session.id,
      paymentIds: [originPayment],
    });
    expect(res.snapshot).toMatchObject({
      number: res.number,
      patient: { fullName: 'Ana Favor' },
      reason: 'El paciente se muda de ciudad',
      creditBefore: 100_000,
      creditAfter: 60_000,
    });
    expect(res.snapshot.payments[0].id).toBe(originPayment);
    expect(res.snapshot.payments[0].receiptNumber).toMatch(/-\d{6}$/);
    // Idempotency-Key: la misma petición devuelve la misma devolución.
    const again = (await refund({ amount: 40_000 }, { key }).expect(201))
      .body as RefundBody;
    expect(again.id).toBe(res.id);

    const detail = (
      await as(api().get(`/api/v1/cash-sessions/${session.id}`), a).expect(200)
    ).body as {
      expected: { currency: string; method: string; expected: number }[];
      creditRefunds: { number: string; amount: number }[];
    };
    expect(
      detail.expected.find((l) => l.currency === 'COP' && l.method === 'CASH')
        ?.expected,
    ).toBe(10_000);
    expect(detail.creditRefunds).toEqual([
      expect.objectContaining({ number: res.number, amount: 40_000 }),
    ]);

    const receipt = (
      await as(api().get(`/api/v1/credit-refunds/${res.id}`), a).expect(200)
    ).body as RefundBody;
    expect(receipt.snapshot.number).toBe(res.number);
  });

  it('dos devoluciones a la vez sobre el mismo saldo: una 201 y otra 409', async () => {
    const [x, y] = await Promise.all([
      refund({ amount: 40_000, method: 'TRANSFER' }),
      refund({ amount: 40_000, method: 'TRANSFER' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const lines = await planLines();
    expect(lines.find((p) => p.id === origin)?.balance).toBe(-20_000);
  });

  it('RECEPTION hasta el tope: dentro devuelve, por encima 403; solo ADMIN cambia el tope', async () => {
    await as(api().put('/api/v1/patient-credit/policy'), a, receptionA)
      .send({ receptionMaxAmount: 1_000_000 })
      .expect(403);
    await as(api().put('/api/v1/patient-credit/policy'), a)
      .send({ receptionMaxAmount: 10_000 })
      .expect(200);
    await refund(
      { amount: 10_000.01, method: 'TRANSFER' },
      { token: receptionA },
    ).expect(403);
    const ok = (
      await refund(
        { amount: 10_000, method: 'TRANSFER' },
        { token: receptionA },
      ).expect(201)
    ).body as RefundBody;
    expect(ok.number).toMatch(/-000003$/);
  });

  it('inmutable: la app no puede actualizar ni borrar un asiento', async () => {
    const entry = await raw.patientCreditEntry.findFirstOrThrow({
      where: { tenantId: a.tenantId },
    });
    await expect(
      raw.patientCreditEntry.update({
        where: { id: entry.id },
        data: { amount: 1 },
      }),
    ).rejects.toThrow(/registro contable/);
  });

  it('otra clínica: 404 sobre el plan y el comprobante de A', async () => {
    const refundId = (
      await raw.patientCreditRefund.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      })
    ).id;
    await as(api().get(`/api/v1/credit-refunds/${refundId}`), b).expect(404);
    await as(
      api().post(`/api/v1/treatment-plans/${origin}/credit-transfers`),
      b,
    )
      .send({ targetPlanId: target, amount: 1, currency: 'COP' })
      .expect(404);
    await as(api().post(`/api/v1/treatment-plans/${origin}/credit-refunds`), b)
      .send({
        amount: 1,
        currency: 'COP',
        method: 'CASH',
        reason: 'Intento ajeno',
        paymentIds: [originPayment],
      })
      .expect(404);
    await as(
      api().get(`/api/v1/patients/${patientId}/credit-movements`),
      b,
    ).expect(404);
  });

  it('un plan de destino o un abono de referencia de otra clínica no se aceptan y no guardan nada', async () => {
    const tenantB = b.tenantId;
    const locationB = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: tenantB },
        select: { id: true },
      })
    ).id;
    const patientB = await raw.patient.create({
      data: {
        tenantId: tenantB,
        firstName: 'Bea',
        lastName: 'Ajena',
        docNumber: 'DX253-B',
      },
    });
    const planB = await raw.treatmentPlan.create({
      data: {
        tenantId: tenantB,
        patientId: patientB.id,
        currency: 'COP',
        status: 'ACCEPTED',
      },
    });
    const paymentB = await raw.payment.create({
      data: {
        tenantId: tenantB,
        locationId: locationB,
        treatmentPlanId: planB.id,
        patientId: patientB.id,
        amount: 1_000,
        currency: 'COP',
        paidAt: new Date(),
        method: 'CASH',
      },
    });
    const before = await counts();
    await transfer({
      targetPlanId: planB.id,
      amount: 1,
      currency: 'COP',
    }).expect(404);
    await refund({
      amount: 1,
      method: 'TRANSFER',
      paymentIds: [paymentB.id],
    }).expect(400);
    expect(await counts()).toEqual(before);
  });

  it('lista los movimientos del paciente y los audita', async () => {
    const res = (
      await as(
        api().get(`/api/v1/patients/${patientId}/credit-movements`),
        a,
      ).expect(200)
    ).body as { transfers: unknown[]; refunds: unknown[] };
    expect(res.transfers).toHaveLength(1);
    expect(res.refunds).toHaveLength(3);
    const events = await raw.auditEvent.count({
      where: {
        tenantId: a.tenantId,
        resourceType: 'PATIENT_CREDIT',
        action: 'CREATE',
      },
    });
    expect(events).toBeGreaterThanOrEqual(4);
  });
  describe('anular un abono cuyo saldo a favor ya salió del plan (409)', () => {
    const voidPayment = (paymentId: string, token = a.adminToken) =>
      as(api().delete(`/api/v1/payments/${paymentId}`), a, token).send({
        reason: 'Registrado por error',
      });
    const isLive = async (paymentId: string): Promise<boolean> =>
      (
        await raw.payment.findUniqueOrThrow({
          where: { id: paymentId },
          select: { deletedAt: true },
        })
      ).deletedAt === null;
    const cancel = (planId: string) =>
      as(api().patch(`/api/v1/treatment-plans/${planId}`), a)
        .send({ status: 'CANCELLED' })
        .expect(200);
    const transferFrom = (planId: string, amount: number) =>
      as(api().post(`/api/v1/treatment-plans/${planId}/credit-transfers`), a)
        .send({ targetPlanId: target, amount, currency: 'COP' })
        .expect(201);

    it('el abono de referencia de una devolución no se anula', async () => {
      const res = await voidPayment(originPayment).expect(409);
      expect((res.body as { message: string }).message).toMatch(
        /^No se puede anular: el abono es referencia de la devolución DEV-[A-Z0-9]+-000001/,
      );
      expect(await isLive(originPayment)).toBe(true);
    });

    it('si sin el abono el saldo traspasado queda al descubierto: 409; si alcanza, se anula', async () => {
      const plan = await seedPlan(100_000, 'ANULA');
      const big = await pay(plan, 60_000);
      const small = await pay(plan, 40_000);
      await cancel(plan);
      await transferFrom(plan, 50_000);

      // 60.000 + 40.000 − 50.000 = 50.000 a favor: anular 40.000 deja 10.000.
      await voidPayment(small).expect(200);
      // Sin los 60.000, el plan habría dado 50.000 que no tiene.
      const res = await voidPayment(big).expect(409);
      expect((res.body as { message: string }).message).toMatch(
        /ya se traspasó o se devolvió/,
      );
      expect(await isLive(big)).toBe(true);
      const line = (await planLines()).find((p) => p.id === plan);
      expect(line).toMatchObject({
        paid: 60_000,
        creditMovements: -50_000,
        balance: -10_000,
      });
    });

    it('cobro dividido (DX-390): anular una línea mira el cobro entero y no anula ninguna', async () => {
      const plan = await seedPlan(100_000, 'DIVIDIDO');
      const methods = (
        await as(api().get('/api/v1/payment-methods'), a).expect(200)
      ).body as { id: string; legacyMethod: string | null }[];
      const split = (
        await as(
          api().post(`/api/v1/treatment-plans/${plan}/split-payments`),
          a,
        )
          .send({
            paidAt: TODAY,
            lines: [
              {
                amount: 30_000,
                currency: 'COP',
                paymentMethodId: methods.find((m) => m.legacyMethod === 'CARD')!
                  .id,
                reference: 'DX253-T1',
              },
              {
                amount: 20_000,
                currency: 'COP',
                paymentMethodId: methods.find(
                  (m) => m.legacyMethod === 'TRANSFER',
                )!.id,
                reference: 'DX253-T2',
              },
            ],
          })
          .expect(201)
      ).body as { payments: { id: string }[] };
      const [first, second] = split.payments.map((p) => p.id);
      await cancel(plan);
      // Solo 10.000 salen, pero la línea 2 arrastra la 1: 50.000 anulados.
      await transferFrom(plan, 10_000);
      await voidPayment(second).expect(409);
      expect(await isLive(first)).toBe(true);
      expect(await isLive(second)).toBe(true);
    });

    it('un abono de un plan sin salidas se sigue anulando', async () => {
      const plan = await seedPlan(100_000, 'LIBRE');
      const payment = await pay(plan, 5_000);
      await voidPayment(payment).expect(200);
      expect(await isLive(payment)).toBe(false);
    });

    it('anulación y devolución a la vez sobre el mismo saldo: nunca las dos', async () => {
      const plan = await seedPlan(100_000, 'CARRERA');
      const payment = await pay(plan, 30_000);
      await cancel(plan);
      const [voided, refunded] = await Promise.all([
        voidPayment(payment),
        as(
          api().post(`/api/v1/treatment-plans/${plan}/credit-refunds`),
          a,
        ).send({
          amount: 30_000,
          currency: 'COP',
          method: 'TRANSFER',
          reason: 'Devolución en carrera',
          paymentIds: [payment],
        }),
      ]);
      const statuses = [voided.status, refunded.status];
      // O se anula primero (la devolución ve 0 a favor o el abono anulado), o
      // se devuelve primero (la anulación ve la referencia): una sola gana.
      expect(statuses.filter((code) => code < 300)).toHaveLength(1);
      const line = (await planLines()).find((p) => p.id === plan);
      expect(line?.balance).toBe(0);
    });
  });
});
