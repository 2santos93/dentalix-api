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
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationBody,
} from './support/location-fixtures';
import { LOCATION_NOT_ALLOWED_CODE } from '../src/shared/tenancy/location-access';

// DX-390 en HTTP real: un cobro de 2–5 formas de pago crea un abono por línea
// y UN recibo en una sola transacción (si una línea falla, no queda ninguna
// ni se gasta número); cada línea respeta su medio (referencia y aviso de
// repetida) y su moneda (tasa congelada); el efectivo entra en la caja
// abierta de quien cobra en su moneda; el total no supera lo pendiente sin
// confirmar el saldo a favor; Idempotency-Key del cobro; auditoría por línea;
// anular una línea anula el cobro y su recibo; aislamiento entre clínicas.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const ZONE = 'America/Bogota';
const TODAY = civilDateIn(new Date(), ZONE);
const PROVIDER = { COP: 4000 };

interface PaymentBody {
  id: string;
  patientId: string;
  amount: number;
  currency: string;
  method: string | null;
  paymentMethodId: string | null;
  reference: string | null;
  duplicateReferenceReason: string | null;
  splitId: string | null;
  splitLine: number | null;
  receiptNumber: string | null;
  exchangeRateStatus: string;
  frozenRate: { currency: string; toPerBase: number } | null;
}

interface SplitBody {
  id: string;
  receiptNumber: string | null;
  planCurrency: string;
  total: number | null;
  payments: PaymentBody[];
}

interface ReceiptBody {
  paymentId: string;
  reference: string;
  voided: boolean;
  exchangeRate: unknown;
  split: {
    lines: {
      paymentId: string;
      line: number;
      amount: number;
      currency: string;
      paymentMethodName: string | null;
      reference: string | null;
      equivalentAmount: number | null;
    }[];
    total: { currency: string; amount: number | null };
  } | null;
  snapshot: {
    payment: { id: string };
    planBalance: { balance: number } | null;
  };
}

interface MethodBody {
  id: string;
  name: string;
  legacyMethod: string | null;
}

describe('Cobro dividido con un solo recibo (e2e, DX-390)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let receptionA: string;
  let planA: string;
  let planB: string;
  let cashA: string;
  let transferA: string;
  let mobileA: string;
  let cashB: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const split = (
    body: Record<string, unknown>,
    { token = receptionA, key }: { token?: string; key?: string } = {},
  ) => {
    const req = as(
      api().post(`/api/v1/treatment-plans/${planA}/split-payments`),
      a,
      token,
    );
    return (key ? req.set('Idempotency-Key', key) : req).send({
      paidAt: TODAY,
      ...body,
    });
  };
  const countPayments = () =>
    raw.payment.count({ where: { tenantId: a.tenantId } });
  const counter = async (): Promise<number> =>
    (
      await raw.paymentReceiptCounter.findMany({
        where: { tenantId: a.tenantId },
      })
    ).reduce((sum, c) => sum + c.lastNumber, 0);

  async function seedPlan(clinic: Clinic, tag: string): Promise<string> {
    const patient = (
      await as(api().post('/api/v1/patients'), clinic)
        .send({
          firstName: 'Ana',
          lastName: 'Dividido',
          docType: 'NATIONAL_ID',
          docNumber: `DX390-${tag}`,
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    const item = (
      await as(api().post('/api/v1/catalog/items'), clinic)
        .send({
          code: `DX390-${tag}`,
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 1_000_000,
        })
        .expect(201)
    ).body as { id: string };
    const planId = (
      (
        await as(
          api().post(`/api/v1/patients/${patient.id}/treatment-plans`),
          clinic,
        )
          .send({ notes: 'Plan DX-390', currency: 'COP' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const planItem = (
      await as(api().post(`/api/v1/treatment-plans/${planId}/items`), clinic)
        .send({ toothNumber: '11', catalogItemId: item.id })
        .expect(201)
    ).body as { id: string };
    await as(
      api().patch(`/api/v1/treatment-plans/${planId}/items/${planItem.id}`),
      clinic,
    )
      .send({ status: 'DONE' })
      .expect(200);
    return planId;
  }

  async function methodsOf(clinic: Clinic): Promise<MethodBody[]> {
    return (await as(api().get('/api/v1/payment-methods'), clinic).expect(200))
      .body as MethodBody[];
  }

  const balance = async (): Promise<{ billable: number; balance: number }> =>
    (
      await as(api().get(`/api/v1/treatment-plans/${planA}/balance`), a).expect(
        200,
      )
    ).body as { billable: number; balance: number };

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({ where: { date: TODAY } });
    await raw.exchangeRateSnapshot.createMany({
      data: Object.entries(PROVIDER).map(([currency, rate]) => ({
        date: TODAY,
        currency,
        rate,
      })),
    });
    a = await registerClinic(app, 'dx390-a');
    b = await registerClinic(app, 'dx390-b');
    const member = await seedMember(raw, a, ClinicRole.RECEPTION);
    receptionA = await loginAs(app, a.host, member.email);
    planA = await seedPlan(a, 'A');
    planB = await seedPlan(b, 'B');
    const methods = await methodsOf(a);
    cashA = methods.find((m) => m.legacyMethod === 'CASH')!.id;
    transferA = methods.find((m) => m.legacyMethod === 'TRANSFER')!.id;
    mobileA = (
      (
        await as(api().post('/api/v1/payment-methods'), a)
          .send({
            name: 'Pago móvil',
            kind: 'DIGITAL',
            requiresReference: true,
          })
          .expect(201)
      ).body as MethodBody
    ).id;
    cashB = (await methodsOf(b)).find((m) => m.legacyMethod === 'CASH')!.id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({ where: { date: TODAY } });
    await app.close();
    await raw.$disconnect();
  });

  let first: SplitBody;
  let sessionId: string;
  const firstKey = randomUUID();
  // Los ids de los medios llegan en beforeAll: el cuerpo se arma al usarlo.
  const firstBody = () => ({
    lines: [
      { amount: 50, currency: 'USD', paymentMethodId: cashA },
      { amount: 100_000, currency: 'COP', paymentMethodId: cashA },
      {
        amount: 50_000,
        currency: 'COP',
        paymentMethodId: transferA,
        reference: 'TR-390-1',
      },
    ],
  });

  it('3 formas de pago en 2 monedas: un abono por línea, un solo recibo y el total en la moneda del plan', async () => {
    // El efectivo de cada línea entra en la caja abierta de quien cobra.
    sessionId = (
      (
        await as(api().post('/api/v1/cash-sessions/open'), a, receptionA)
          .send({ floats: [] })
          .expect(201)
      ).body as { id: string }
    ).id;
    const before = await counter();

    const res = await split(firstBody(), { key: firstKey }).expect(201);
    first = res.body as SplitBody;

    expect(first.planCurrency).toBe('COP');
    // 50 USD × 4000 + 100 000 + 50 000.
    expect(first.total).toBe(350_000);
    expect(first.payments).toHaveLength(3);
    expect(first.id).toBe(first.payments[0].id);
    expect(first.payments.map((p) => [p.splitId, p.splitLine])).toEqual([
      [first.id, 1],
      [first.id, 2],
      [first.id, 3],
    ]);
    expect(new Set(first.payments.map((p) => p.receiptNumber))).toEqual(
      new Set([first.receiptNumber]),
    );
    expect(first.receiptNumber).toMatch(/^[A-Z0-9]+-\d{6}$/);
    expect(await counter()).toBe(before + 1);
    // Cada moneda con su tasa congelada (DX-375).
    expect(first.payments[0]).toMatchObject({
      currency: 'USD',
      method: 'CASH',
      exchangeRateStatus: 'FROZEN',
      frozenRate: { currency: 'COP', toPerBase: 4000 },
    });
    expect(first.payments[2]).toMatchObject({
      method: 'TRANSFER',
      reference: 'TR-390-1',
      exchangeRateStatus: 'NOT_NEEDED',
    });

    // Un solo recibo, con todas las líneas, sea cual sea la línea pedida.
    const receipt = (
      await as(
        api().get(`/api/v1/payments/${first.payments[2].id}/receipt`),
        a,
        receptionA,
      ).expect(200)
    ).body as ReceiptBody;
    expect(receipt.paymentId).toBe(first.id);
    expect(receipt.reference).toBe(first.receiptNumber);
    expect(receipt.exchangeRate).toBeNull();
    expect(receipt.split?.total).toEqual({ currency: 'COP', amount: 350_000 });
    expect(
      receipt.split?.lines.map((l) => [
        l.line,
        l.amount,
        l.currency,
        l.paymentMethodName,
        l.reference,
        l.equivalentAmount,
      ]),
    ).toEqual([
      [1, 50, 'USD', 'Efectivo', null, 200_000],
      [2, 100_000, 'COP', 'Efectivo', null, 100_000],
      [3, 50_000, 'COP', 'Transferencia', 'TR-390-1', 50_000],
    ]);
    expect(receipt.snapshot.planBalance?.balance).toBe(650_000);
    expect(
      await raw.paymentReceipt.count({ where: { tenantId: a.tenantId } }),
    ).toBe(1);

    // La caja abierta: cada línea en efectivo en su moneda; la transferencia no.
    const detail = (
      await as(
        api().get(`/api/v1/cash-sessions/${sessionId}`),
        a,
        receptionA,
      ).expect(200)
    ).body as {
      expected: { currency: string; method: string; payments: number }[];
      payments: { id: string; receiptNumber: string | null }[];
    };
    const line = (currency: string, method: string) =>
      detail.expected.find(
        (l) => l.currency === currency && l.method === method,
      );
    expect(line('USD', 'CASH')?.payments).toBe(50);
    expect(line('COP', 'CASH')?.payments).toBe(100_000);
    expect(detail.payments.map((p) => p.id).sort()).toEqual(
      first.payments.map((p) => p.id).sort(),
    );
    // QA DX-390 (B1): las líneas 2..N del turno llevan el recibo del cobro.
    expect(detail.payments.map((p) => p.receiptNumber)).toEqual(
      first.payments.map(() => first.receiptNumber),
    );

    // Auditoría: un CREATE por línea, con el recibo del cobro.
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        action: 'CREATE',
        resourceType: 'PAYMENT',
        resourceId: { in: first.payments.map((p) => p.id) },
      },
      select: { resourceId: true, patientId: true, metadata: true },
    });
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.patientId).not.toBeNull();
      expect(event.metadata).toMatchObject({ reason: 'SPLIT_RECEIPT_ISSUED' });
    }
  });

  it('repetir el cobro con la misma Idempotency-Key devuelve el original sin registrar nada', async () => {
    const before = await countPayments();
    const res = await split(firstBody(), { key: firstKey }).expect(201);
    expect((res.body as SplitBody).id).toBe(first.id);
    expect((res.body as SplitBody).total).toBe(350_000);
    expect(await countPayments()).toBe(before);
    // Con otro cuerpo, o en el endpoint del abono suelto: 422.
    await split(
      { lines: firstBody().lines.slice(0, 2) },
      { key: firstKey },
    ).expect(422);
    await as(
      api().post(`/api/v1/treatment-plans/${planA}/payments`),
      a,
      receptionA,
    )
      .set('Idempotency-Key', firstKey)
      .send({
        amount: 50,
        currency: 'USD',
        paidAt: TODAY,
        paymentMethodId: cashA,
      })
      .expect(422);
  });

  it('atomicidad: si una línea falla dentro de la transacción, no queda ninguna ni se gasta número', async () => {
    // El ADMIN no tiene caja abierta y la clínica la exige para el efectivo:
    // la línea 2 (efectivo) falla DESPUÉS de insertar la línea 1.
    await as(api().put('/api/v1/cash-sessions/settings'), a)
      .send({ requireOpenSession: true, blindClose: false })
      .expect(200);
    const before = await countPayments();
    const numbers = await counter();
    const res = await split(
      {
        lines: [
          {
            amount: 10_000,
            currency: 'COP',
            paymentMethodId: transferA,
            reference: 'TR-390-ATOM',
          },
          { amount: 5_000, currency: 'COP', paymentMethodId: cashA },
        ],
      },
      { token: a.adminToken },
    ).expect(409);
    expect((res.body as { message: string }).message).toMatch(/caja abierta/);
    expect(await countPayments()).toBe(before);
    expect(await counter()).toBe(numbers);
    expect(
      await raw.payment.count({ where: { reference: 'TR-390-ATOM' } }),
    ).toBe(0);
    await as(api().put('/api/v1/cash-sessions/settings'), a)
      .send({ requireOpenSession: false, blindClose: false })
      .expect(200);
  });

  it('cada línea respeta su medio: la referencia que pide (400), un medio de otra clínica (400) y menos de 2 líneas (400), en español', async () => {
    const before = await countPayments();
    const missing = await split({
      lines: [
        { amount: 1_000, currency: 'COP', paymentMethodId: cashA },
        { amount: 1_000, currency: 'COP', paymentMethodId: mobileA },
      ],
    }).expect(400);
    expect((missing.body as { message: string }).message).toBe(
      'Este medio de pago pide la referencia del pago.',
    );
    await split({
      lines: [
        { amount: 1_000, currency: 'COP', paymentMethodId: cashA },
        { amount: 1_000, currency: 'COP', paymentMethodId: cashB },
      ],
    }).expect(400);
    const one = await split({
      lines: [{ amount: 1_000, currency: 'COP', paymentMethodId: cashA }],
    }).expect(400);
    expect(JSON.stringify(one.body)).toContain('de 2 a 5 formas de pago');
    expect(await countPayments()).toBe(before);
  });

  it('la referencia repetida de una línea → 409 con su línea; con el motivo de esa línea se registra', async () => {
    const lines = [
      { amount: 1_000, currency: 'COP', paymentMethodId: cashA },
      {
        amount: 2_000,
        currency: 'COP',
        paymentMethodId: transferA,
        reference: 'tr 390 1',
      },
    ];
    const key = randomUUID();
    const res = await split({ lines }, { key }).expect(409);
    expect(res.body).toMatchObject({
      code: 'PAYMENT_REFERENCE_DUPLICATE',
      line: 1,
      matches: [
        { id: first.payments[2].id, receiptNumber: first.receiptNumber },
      ],
    });
    const ok = await split(
      {
        lines: [
          lines[0],
          {
            ...lines[1],
            duplicateReferenceReason: 'Otro pago del mismo banco',
          },
        ],
      },
      { key },
    ).expect(201);
    const saved = (ok.body as SplitBody).payments[1];
    expect(saved.duplicateReferenceReason).toBe('Otro pago del mismo banco');
    const event = await raw.auditEvent.findFirstOrThrow({
      where: { tenantId: a.tenantId, action: 'CREATE', resourceId: saved.id },
      select: { metadata: true },
    });
    expect(event.metadata).toMatchObject({
      paymentReference: {
        duplicateConfirmed: true,
        duplicateOf: [first.payments[2].id],
      },
    });
    expect(JSON.stringify(event.metadata)).not.toContain('mismo banco');
  });

  it('el total no supera lo pendiente sin confirmar el saldo a favor (409 con las cifras en la moneda del plan)', async () => {
    const { balance: pending } = await balance();
    const lines = [
      { amount: 100, currency: 'USD', paymentMethodId: cashA },
      { amount: pending, currency: 'COP', paymentMethodId: cashA },
    ];
    const key = randomUUID();
    const res = await split({ lines }, { key }).expect(409);
    expect(res.body).toMatchObject({
      code: 'SPLIT_PAYMENT_EXCEEDS_BALANCE',
      currency: 'COP',
      total: pending + 400_000,
      pending,
      excess: 400_000,
    });
    expect((res.body as { message: string }).message).toMatch(/saldo a favor/);
    const ok = await split(
      { lines, confirmCreditBalance: true },
      { key },
    ).expect(201);
    expect((ok.body as SplitBody).total).toBe(pending + 400_000);
    expect((await balance()).balance).toBe(-400_000);

    // QA DX-390 (B2): con ese saldo a favor previo, lo pendiente es 0 y el
    // excedente de otro cobro es solo su total, sin los 400 000 de antes.
    const again = await split({
      lines: [
        { amount: 30_000, currency: 'COP', paymentMethodId: cashA },
        { amount: 30_000, currency: 'COP', paymentMethodId: cashA },
      ],
    }).expect(409);
    expect(again.body).toMatchObject({
      code: 'SPLIT_PAYMENT_EXCEEDS_BALANCE',
      total: 60_000,
      pending: 0,
      excess: 60_000,
    });
  });

  // Revisión DX-390: la caja y el estado de cuenta (donde también se anula)
  // dicen de qué cobro es cada línea y cuántas tiene, para avisar antes de
  // anular que se anula el cobro entero. Aunque el filtro deje ver solo una.
  it('la caja y el estado de cuenta dicen el cobro de cada línea y cuántas tiene', async () => {
    const ids = first.payments.map((p) => p.id);
    const cash = (
      await as(
        api().get(
          `/api/v1/payments?from=${TODAY}&to=${TODAY}&paymentMethodId=${transferA}`,
        ),
        a,
        receptionA,
      ).expect(200)
    ).body as {
      items: {
        id: string;
        splitId: string | null;
        splitLines: number | null;
      }[];
    };
    const cashLine = cash.items.find((item) => item.id === ids[2]);
    expect(cashLine).toMatchObject({ splitId: first.id, splitLines: 3 });
    expect(cash.items.filter((item) => ids.includes(item.id))).toHaveLength(1);

    const statement = (
      await as(
        api().get(
          `/api/v1/patients/${first.payments[0].patientId}/account-statement`,
        ),
        a,
        receptionA,
      ).expect(200)
    ).body as {
      movements: {
        id: string;
        splitId: string | null;
        splitLines: number | null;
      }[];
    };
    const lines = statement.movements.filter((m) => ids.includes(m.id));
    expect(lines).toHaveLength(3);
    for (const movement of lines) {
      expect(movement).toMatchObject({ splitId: first.id, splitLines: 3 });
    }
  });

  it('DX-089-bis: autor restringido no anula ninguna línea ni altera recibo, imputaciones, compromiso o saldo a favor', async () => {
    const payment = await raw.payment.findUniqueOrThrow({
      where: { id: first.id },
    });
    const author = await raw.user.findUniqueOrThrow({
      where: { id: payment.createdById! },
    });
    const allowed: string[] = [];
    for (const name of ['Norte DX089', 'Sur DX089']) {
      const location = (
        await as(api().post('/api/v1/locations'), a)
          .send(locationBody(REGIONAL_BOGOTA_FIXTURE, { name }))
          .expect(201)
      ).body as { id: string };
      allowed.push(location.id);
    }
    // El saldo traspasable usa abonos en la moneda del plan (DX-253).
    // Otros cobros COP dejan margen incluso tras anular el primer cobro.
    await split({
      lines: [
        { amount: 250_000, currency: 'COP', paymentMethodId: cashA },
        { amount: 250_000, currency: 'COP', paymentMethodId: cashA },
      ],
      confirmCreditBalance: true,
    }).expect(201);
    // Un traspaso real deja asientos que también deben permanecer inalterados.
    const target = await raw.treatmentPlan.create({
      data: {
        tenantId: a.tenantId,
        patientId: payment.patientId,
        currency: 'COP',
      },
    });
    await as(api().post(`/api/v1/treatment-plans/${planA}/credit-transfers`), a)
      .send({ targetPlanId: target.id, amount: 10_000, currency: 'COP' })
      .expect(201);
    const promise = await raw.paymentPromise.create({
      data: {
        tenantId: a.tenantId,
        patientId: payment.patientId,
        locationId: payment.locationId,
        amount: 1,
        currency: 'COP',
        dueDate: new Date(`${TODAY}T00:00:00.000Z`),
        createdById: author.id,
      },
    });
    await raw.paymentPromise.update({
      where: { id: promise.id },
      data: { status: 'KEPT', settledAt: new Date() },
    });
    await as(api().put(`/api/v1/staff/${author.id}/locations`), a)
      .send({ locationIds: allowed })
      .expect(200);
    const restricted = await loginAs(app, a.host, author.email);
    const state = async () => {
      const query = {
        where: { tenantId: a.tenantId },
        orderBy: { id: 'asc' as const },
      };
      return {
        payments: await raw.payment.findMany(query),
        receipts: await raw.paymentReceipt.findMany(query),
        allocations: await raw.paymentAllocation.findMany(query),
        allocationMovements:
          await raw.paymentAllocationMovement.findMany(query),
        promises: await raw.paymentPromise.findMany(query),
        creditEntries: await raw.patientCreditEntry.findMany(query),
        creditTransfers: await raw.patientCreditTransfer.findMany(query),
        creditRefunds: await raw.patientCreditRefund.findMany(query),
        events: await raw.auditEvent.findMany(query),
      };
    };
    const balanceBefore = await balance();
    const before = await state();
    expect(before.payments.filter((p) => p.splitId === first.id)).toHaveLength(
      3,
    );
    expect(before.receipts.some((r) => r.paymentId === first.id)).toBe(true);
    expect(before.allocations.some((p) => p.paymentId === first.id)).toBe(true);
    expect(before.promises.some((p) => p.status === 'KEPT')).toBe(true);
    expect(before.creditEntries).toHaveLength(2);
    try {
      // Ambas cabeceras son válidas; el rechazo debe venir de la sede
      // persistida, no del rol, autor, día o validación de la cabecera.
      for (const active of [undefined, allowed[0]]) {
        for (const line of first.payments) {
          const req = as(
            api().delete(`/api/v1/payments/${line.id}`),
            a,
            restricted,
          );
          const res = await (active ? req.set('X-Location-Id', active) : req)
            .send({ reason: 'Cobro registrado dos veces' })
            .expect(403);
          expect(res.body).toMatchObject({ code: LOCATION_NOT_ALLOWED_CODE });
          expect(await state()).toEqual(before);
        }
      }
      // Esta lectura se audita como VIEW: va después de comprobar que los
      // rechazos no escribieron ningún evento.
      expect(await balance()).toEqual(balanceBefore);
    } finally {
      await as(api().put(`/api/v1/staff/${author.id}/locations`), a)
        .send({ locationIds: [] })
        .expect(200);
      receptionA = await loginAs(app, a.host, author.email);
    }
  });

  it('anular una línea anula el cobro entero y su recibo, con un evento VOID por línea', async () => {
    await as(
      api().delete(`/api/v1/payments/${first.payments[1].id}`),
      a,
      receptionA,
    )
      .send({ reason: 'Cobro registrado dos veces' })
      .expect(200);
    const rows = await raw.payment.findMany({
      where: { splitId: first.id },
      select: { deletedAt: true, voidReason: true },
    });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.deletedAt).not.toBeNull();
      expect(row.voidReason).toBe('Cobro registrado dos veces');
    }
    const receipt = (
      await as(
        api().get(`/api/v1/payments/${first.payments[0].id}/receipt`),
        a,
        receptionA,
      ).expect(200)
    ).body as ReceiptBody;
    expect(receipt.voided).toBe(true);
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        action: 'VOID',
        resourceId: { in: first.payments.map((p) => p.id) },
      },
      select: { resourceId: true },
    });
    expect(events.map((e) => e.resourceId).sort()).toEqual(
      first.payments.map((p) => p.id).sort(),
    );
    // Ya anulado: 404 para cualquiera de sus líneas.
    await as(api().delete(`/api/v1/payments/${first.payments[2].id}`), a)
      .send({ reason: 'Otra vez' })
      .expect(404);
  });

  // ISOLATION_COVERS: POST /treatment-plans/:id/split-payments
  it('aislamiento: la clínica B no cobra en el plan de A (404) ni ve sus recibos', async () => {
    await as(api().post(`/api/v1/treatment-plans/${planA}/split-payments`), b)
      .send({
        paidAt: TODAY,
        lines: [
          { amount: 1_000, currency: 'COP', paymentMethodId: cashB },
          { amount: 1_000, currency: 'COP', paymentMethodId: cashB },
        ],
      })
      .expect(404);
    await as(api().get(`/api/v1/payments/${first.id}/receipt`), b).expect(404);
    // Y su propio cobro dividido funciona en su plan.
    await as(api().post(`/api/v1/treatment-plans/${planB}/split-payments`), b)
      .send({
        paidAt: TODAY,
        lines: [
          { amount: 1_000, currency: 'COP', paymentMethodId: cashB },
          { amount: 2_000, currency: 'COP', paymentMethodId: cashB },
        ],
      })
      .expect(201);
  });

  it('el dentista no registra cobros (403)', async () => {
    const dentist = await seedMember(raw, a, ClinicRole.DENTIST);
    const token = await loginAs(app, a.host, dentist.email);
    await split(
      {
        lines: [
          { amount: 1_000, currency: 'COP', paymentMethodId: cashA },
          { amount: 1_000, currency: 'COP', paymentMethodId: cashA },
        ],
      },
      { token },
    ).expect(403);
  });
});
