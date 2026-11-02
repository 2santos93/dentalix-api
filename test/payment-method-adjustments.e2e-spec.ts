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
import { sedeTodayFixture } from './support/sede-clock';

// DX-516 en HTTP real: ajustes por medio de pago (impuesto, recargo o
// descuento). Sin ajustes nada cambia; solo el ADMIN los configura, con su
// evento de configuración (antes y después); el abono los congela (cambiar la
// configuración después no recalcula); cada parte de un cobro dividido usa
// los de su medio; el saldo del plan se mueve por el importe (impuestos y
// recargos aparte, descuentos como abono); la caja, el arqueo, el CSV y el
// recibo llevan lo cobrado; anular el abono anula sus ajustes y la caja
// cuadra; la tabla de lo congelado no admite cambios; aislamiento entre
// clínicas.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// La sede en una zona lejos de su medianoche (DX-449): los abonos «de hoy»
// caen en la caja abierta, nunca como tardíos.
const SEDE = sedeTodayFixture();

interface Adjustment {
  type: string;
  label: string;
  calculation: string;
  percent: number | null;
  fixedAmount: number | null;
  base: number;
  amount: number;
  currency: string;
}

interface PaymentBody {
  id: string;
  amount: number;
  adjustments: Adjustment[];
  collectedAmount: number;
}

interface MethodBody {
  id: string;
  name: string;
  legacyMethod: string | null;
  adjustments: { id: string; label: string; percent: number | null }[];
}

interface ExpectedLine {
  currency: string;
  method: string;
  payments: number;
  paymentAdjustments: number;
  adjustments: number;
  expected: number;
}

describe('Ajustes por medio de pago (e2e, DX-516)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let receptionA: string;
  let sedeA: string;
  let planA: string;
  let cashA: string;
  let cardA: string;
  let cashB: string;
  let taxId: string;
  let sessionId: string;
  let today: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const asReception = (req: request.Test) =>
    as(req, a, receptionA).set('X-Location-Id', sedeA);

  const pay = (body: Record<string, unknown>) =>
    asReception(api().post(`/api/v1/treatment-plans/${planA}/payments`)).send({
      currency: 'USD',
      paidAt: today,
      ...body,
    });

  const methodsOf = async (clinic: Clinic): Promise<MethodBody[]> =>
    (
      await as(
        api().get('/api/v1/payment-methods?includeInactive=true'),
        clinic,
      ).expect(200)
    ).body as MethodBody[];

  const configEvents = (clinic: Clinic) =>
    raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        resourceType: 'PAYMENT_METHOD',
        metadata: {
          path: ['reason'],
          string_starts_with: 'PAYMENT_METHOD_ADJUSTMENT_',
        },
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: { action: true, resourceId: true, metadata: true },
    });

  const sessionLine = async (currency: string, method: string) => {
    const detail = (
      await asReception(api().get(`/api/v1/cash-sessions/${sessionId}`)).expect(
        200,
      )
    ).body as { expected: ExpectedLine[] };
    return detail.expected.find(
      (l) => l.currency === currency && l.method === method,
    );
  };

  async function seedPlan(clinic: Clinic, tag: string): Promise<string> {
    const patient = (
      await as(api().post('/api/v1/patients'), clinic)
        .send({
          firstName: 'Ana',
          lastName: 'Ajustes',
          docType: 'NATIONAL_ID',
          docNumber: `DX516-${tag}`,
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    const item = (
      await as(api().post('/api/v1/catalog/items'), clinic)
        .send({
          code: `DX516-${tag}`,
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 1000,
        })
        .expect(201)
    ).body as { id: string };
    const planId = (
      (
        await as(
          api().post(`/api/v1/patients/${patient.id}/treatment-plans`),
          clinic,
        )
          .send({ notes: 'Plan DX-516', currency: 'USD' })
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

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx516-a', SEDE);
    b = await registerClinic(app, 'dx516-b', SEDE);
    today = civilDateIn(new Date(), SEDE.timeZone);
    const member = await seedMember(raw, a, ClinicRole.RECEPTION);
    receptionA = await loginAs(app, a.host, member.email);
    sedeA = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      })
    ).id;
    planA = await seedPlan(a, 'A');
    const methodsA = await methodsOf(a);
    cashA = methodsA.find((m) => m.legacyMethod === 'CASH')!.id;
    cardA = methodsA.find((m) => m.legacyMethod === 'CARD')!.id;
    cashB = (await methodsOf(b)).find((m) => m.legacyMethod === 'CASH')!.id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('por defecto ningún medio tiene ajustes y un abono no cambia (cobrado = importe, recibo sin clave nueva)', async () => {
    for (const m of [...(await methodsOf(a)), ...(await methodsOf(b))]) {
      expect(m.adjustments).toEqual([]);
    }
    const res = await pay({ amount: 10, paymentMethodId: cashA }).expect(201);
    const body = res.body as PaymentBody;
    expect(body.adjustments).toEqual([]);
    expect(body.collectedAmount).toBe(10);
    const receipt = (
      await asReception(
        api().get(`/api/v1/payments/${body.id}/receipt`),
      ).expect(200)
    ).body as { snapshot: { payment: Record<string, unknown> } };
    expect(receipt.snapshot.payment).not.toHaveProperty('adjustments');
    expect(await raw.paymentAdjustment.count()).toBe(0);
    // Lo anulamos para empezar la caja limpia.
    await as(api().delete(`/api/v1/payments/${body.id}`), a)
      .send({ reason: 'Prueba sin ajustes' })
      .expect(200);
  });

  it('solo el ADMIN configura (403 en español); validación en español', async () => {
    const forbidden = await asReception(
      api().post(`/api/v1/payment-methods/${cashA}/adjustments`),
    )
      .send({
        type: 'TAX',
        label: 'Impuesto 3 %',
        calculation: 'PERCENT',
        percent: 3,
      })
      .expect(403);
    expect((forbidden.body as { message: string }).message).toBe(
      'Solo un administrador puede gestionar los medios de pago.',
    );
    const post = (body: Record<string, unknown>) =>
      as(api().post(`/api/v1/payment-methods/${cashA}/adjustments`), a).send(
        body,
      );
    await post({
      type: 'TAX',
      label: 'Cero',
      calculation: 'PERCENT',
      percent: 0,
    }).expect(400);
    await post({
      type: 'TAX',
      label: 'x'.repeat(41),
      calculation: 'PERCENT',
      percent: 3,
    }).expect(400);
    await post({
      type: 'SURCHARGE',
      label: 'Sin moneda',
      calculation: 'FIXED',
      fixedAmount: 2,
    }).expect(400);
    await post({
      type: 'SURCHARGE',
      label: 'Tres decimales',
      calculation: 'FIXED',
      fixedAmount: 2.555,
      fixedCurrency: 'USD',
    }).expect(400);
    await post({
      type: 'TAX',
      label: 'Mezcla',
      calculation: 'PERCENT',
      percent: 3,
      fixedAmount: 1,
      fixedCurrency: 'USD',
    }).expect(400);
    expect(await raw.paymentMethodAdjustment.count()).toBe(0);
  });

  it('el ADMIN crea un impuesto del 3 % en el efectivo, auditado con el después; etiqueta repetida es 409', async () => {
    const created = await as(
      api().post(`/api/v1/payment-methods/${cashA}/adjustments`),
      a,
    )
      .send({
        type: 'TAX',
        label: 'Impuesto 3 %',
        calculation: 'PERCENT',
        percent: 3,
      })
      .expect(201);
    taxId = (created.body as { id: string }).id;
    expect(created.body).toMatchObject({
      type: 'TAX',
      label: 'Impuesto 3 %',
      calculation: 'PERCENT',
      percent: 3,
      fixedAmount: null,
      fixedCurrency: null,
      active: true,
    });
    await as(api().post(`/api/v1/payment-methods/${cashA}/adjustments`), a)
      .send({
        type: 'SURCHARGE',
        label: 'impuesto 3 %',
        calculation: 'PERCENT',
        percent: 1,
      })
      .expect(409);
    const [event] = await configEvents(a);
    expect(event).toMatchObject({
      action: 'CREATE',
      resourceId: cashA,
      metadata: {
        reason: 'PAYMENT_METHOD_ADJUSTMENT_CREATED',
        configChange: {
          after: {
            adjustmentLabel: 'Impuesto 3 %',
            adjustmentType: 'TAX',
            calculation: 'PERCENT',
            percent: 3,
            fixedAmount: null,
            fixedCurrency: null,
            active: true,
          },
        },
      },
    });
    const cash = (await methodsOf(a)).find((m) => m.id === cashA)!;
    expect(cash.adjustments).toEqual([
      expect.objectContaining({ id: taxId, label: 'Impuesto 3 %', percent: 3 }),
    ]);
  });

  let taxedId: string;

  it('el abono congela el impuesto: el plan se mueve por el importe; la caja, el arqueo y el recibo, por lo cobrado', async () => {
    const opened = await asReception(api().post('/api/v1/cash-sessions/open'))
      .send({ floats: [{ currency: 'USD', amount: 20 }] })
      .expect(201);
    sessionId = (opened.body as { id: string }).id;

    const res = await pay({ amount: 100, paymentMethodId: cashA }).expect(201);
    const body = res.body as PaymentBody;
    taxedId = body.id;
    expect(body.amount).toBe(100);
    expect(body.collectedAmount).toBe(103);
    expect(body.adjustments).toEqual([
      {
        type: 'TAX',
        label: 'Impuesto 3 %',
        calculation: 'PERCENT',
        percent: 3,
        fixedAmount: null,
        base: 100,
        amount: 3,
        currency: 'USD',
      },
    ]);

    // Saldo del plan: abonado 100 (el impuesto se cobra aparte).
    const balance = (
      await as(api().get(`/api/v1/treatment-plans/${planA}/balance`), a).expect(
        200,
      )
    ).body as { paid: number; balance: number };
    expect(balance).toMatchObject({ paid: 100, balance: 900 });

    // Arqueo: fondo 20 + abono 100 + ajuste 3 = 123.
    expect(await sessionLine('USD', 'CASH')).toMatchObject({
      payments: 100,
      paymentAdjustments: 3,
      adjustments: 0,
      expected: 123,
    });

    // Recibo: el ajuste con su base, congelado en la foto.
    const receipt = (
      await asReception(
        api().get(`/api/v1/payments/${taxedId}/receipt`),
      ).expect(200)
    ).body as { snapshot: { payment: { adjustments: Adjustment[] } } };
    expect(receipt.snapshot.payment.adjustments).toEqual(body.adjustments);

    // Caja: fila y resumen con lo cobrado.
    const cash = (
      await asReception(
        api().get(`/api/v1/payments?from=${today}&to=${today}`),
      ).expect(200)
    ).body as {
      items: PaymentBody[];
      summary: {
        byCurrency: { currency: string; total: number }[];
        adjustments: { currency: string; type: string; total: number }[];
        collected: { currency: string; total: number }[];
      };
    };
    expect(cash.items.find((i) => i.id === taxedId)).toMatchObject({
      collectedAmount: 103,
    });
    expect(cash.summary.byCurrency).toEqual([
      expect.objectContaining({ currency: 'USD', total: 100 }),
    ]);
    expect(cash.summary.adjustments).toEqual([
      { currency: 'USD', type: 'TAX', total: 3, count: 1 },
    ]);
    expect(cash.summary.collected).toEqual([{ currency: 'USD', total: 103 }]);

    // CSV: columnas al final.
    const csv = await asReception(
      api().get(`/api/v1/payments.csv?from=${today}&to=${today}`),
    ).expect(200);
    const lines = csv.text.split('\r\n');
    expect(lines[0]).toContain(
      'Importe,Impuestos,Recargos,Descuentos,Total cobrado,Detalle de ajustes',
    );
    expect(
      lines.some((l) =>
        l.endsWith(',USD,100.00,3.00,,,103.00,"Impuesto 3 % +3.00"'),
      ),
    ).toBe(true);
  });

  it('cambiar la configuración después no recalcula el abono (congelado) y deja el antes y el después', async () => {
    await as(
      api().patch(`/api/v1/payment-methods/${cashA}/adjustments/${taxId}`),
      a,
    )
      .send({ percent: 10, label: 'Impuesto 10 %' })
      .expect(200);
    const events = await configEvents(a);
    expect(events.at(-1)).toMatchObject({
      action: 'UPDATE',
      resourceId: cashA,
      metadata: {
        reason: 'PAYMENT_METHOD_ADJUSTMENT_UPDATED',
        changedFields: ['adjustmentLabel', 'percent'],
        configChange: {
          before: { adjustmentLabel: 'Impuesto 3 %', percent: 3 },
          after: { adjustmentLabel: 'Impuesto 10 %', percent: 10 },
        },
      },
    });
    // Sin cambio, sin evento.
    await as(
      api().patch(`/api/v1/payment-methods/${cashA}/adjustments/${taxId}`),
      a,
    )
      .send({ percent: 10 })
      .expect(200);
    expect(await configEvents(a)).toHaveLength(events.length);

    const payments = (
      await as(
        api().get(`/api/v1/treatment-plans/${planA}/payments`),
        a,
      ).expect(200)
    ).body as PaymentBody[];
    expect(payments.find((p) => p.id === taxedId)).toMatchObject({
      collectedAmount: 103,
      adjustments: [
        expect.objectContaining({ label: 'Impuesto 3 %', amount: 3 }),
      ],
    });
    const receipt = (
      await asReception(
        api().get(`/api/v1/payments/${taxedId}/receipt`),
      ).expect(200)
    ).body as { snapshot: { payment: { adjustments: Adjustment[] } } };
    expect(receipt.snapshot.payment.adjustments[0]).toMatchObject({
      label: 'Impuesto 3 %',
      amount: 3,
    });
  });

  it('la tabla de lo congelado no admite cambios ni borrados (trigger)', async () => {
    await expect(
      raw.$executeRaw`UPDATE "payment_adjustments" SET "amount" = 1 WHERE "paymentId" = ${taxedId}::uuid`,
    ).rejects.toThrow(/inalterable/);
  });

  let splitHead: string;

  it('cobro dividido: cada parte aplica el ajuste de su propio medio; el descuento cuenta como abono', async () => {
    await as(api().post(`/api/v1/payment-methods/${cardA}/adjustments`), a)
      .send({
        type: 'DISCOUNT',
        label: 'Descuento fijo',
        calculation: 'FIXED',
        fixedAmount: 5,
        fixedCurrency: 'USD',
      })
      .expect(201);
    const res = await asReception(
      api().post(`/api/v1/treatment-plans/${planA}/split-payments`),
    )
      .send({
        paidAt: today,
        lines: [
          { amount: 50, currency: 'USD', paymentMethodId: cashA },
          { amount: 50, currency: 'USD', paymentMethodId: cardA },
        ],
      })
      .expect(201);
    const split = res.body as { payments: PaymentBody[] };
    splitHead = split.payments[0].id;
    expect(
      split.payments.map((p) => [
        p.collectedAmount,
        p.adjustments.map((x) => [x.type, x.amount]),
      ]),
    ).toEqual([
      [55, [['TAX', 5]]],
      [45, [['DISCOUNT', 5]]],
    ]);
    // El plan: 100 + 50 + 50 (el descuento cuenta como abono).
    const balance = (
      await as(api().get(`/api/v1/treatment-plans/${planA}/balance`), a).expect(
        200,
      )
    ).body as { paid: number };
    expect(balance.paid).toBe(200);
    const receipt = (
      await asReception(
        api().get(`/api/v1/payments/${splitHead}/receipt`),
      ).expect(200)
    ).body as {
      snapshot: {
        payment: Record<string, unknown>;
        split: { lines: { adjustments?: Adjustment[] }[] };
      };
    };
    expect(receipt.snapshot.payment).not.toHaveProperty('adjustments');
    expect(
      receipt.snapshot.split.lines.map((l) =>
        l.adjustments?.map((x) => x.label),
      ),
    ).toEqual([['Impuesto 10 %'], ['Descuento fijo']]);
    // Arqueo: efectivo 20 + 100 + 50 + (3 + 5); tarjeta 50 − 5.
    expect(await sessionLine('USD', 'CASH')).toMatchObject({
      payments: 150,
      paymentAdjustments: 8,
      expected: 178,
    });
    expect(await sessionLine('USD', 'CARD')).toMatchObject({
      payments: 50,
      paymentAdjustments: -5,
      expected: 45,
    });
  });

  it('anular un abono anula también sus ajustes y la caja cuadra', async () => {
    await as(api().delete(`/api/v1/payments/${taxedId}`), a)
      .send({ reason: 'Cobro duplicado' })
      .expect(200);
    await as(api().delete(`/api/v1/payments/${splitHead}`), a)
      .send({ reason: 'Cobro duplicado' })
      .expect(200);
    expect(await sessionLine('USD', 'CASH')).toMatchObject({
      payments: 0,
      paymentAdjustments: 0,
      expected: 20,
    });
    const card = await sessionLine('USD', 'CARD');
    expect(card?.expected ?? 0).toBe(0);
    const cash = (
      await asReception(
        api().get(`/api/v1/payments?from=${today}&to=${today}`),
      ).expect(200)
    ).body as {
      summary: { adjustments: unknown[]; collected: unknown[] };
    };
    expect(cash.summary.adjustments).toEqual([]);
    expect(cash.summary.collected).toEqual([]);
    // Las líneas congeladas siguen ahí (append-only), unidas a su abono anulado.
    expect(await raw.paymentAdjustment.count()).toBe(3);
  });

  it('con la caja ya cerrada, anular compensa lo cobrado entero (ajuste VOID con el impuesto)', async () => {
    const res = await pay({ amount: 200, paymentMethodId: cashA }).expect(201);
    const id = (res.body as PaymentBody).id;
    expect((res.body as PaymentBody).collectedAmount).toBe(220);
    const line = await sessionLine('USD', 'CASH');
    await asReception(api().post(`/api/v1/cash-sessions/${sessionId}/close`))
      .send({
        counts: [{ currency: 'USD', method: 'CASH', counted: line!.expected }],
      })
      .expect(201);
    await as(api().delete(`/api/v1/payments/${id}`), a)
      .send({ reason: 'Devuelto al paciente' })
      .expect(200);
    const voidAdjustment = await raw.cashSessionAdjustment.findFirstOrThrow({
      where: { paymentId: id, kind: 'VOID' },
      select: { amount: true, currency: true, method: true },
    });
    expect(voidAdjustment.amount.toNumber()).toBe(-220);
  });

  // ISOLATION_COVERS: POST /payment-methods/:id/adjustments
  // ISOLATION_COVERS: PATCH /payment-methods/:id/adjustments/:adjustmentId
  it('aislamiento: la clínica B no añade ni edita ajustes en los medios de A (404) y A no cambia', async () => {
    const before = await raw.paymentMethodAdjustment.findMany({
      where: { tenantId: a.tenantId },
      orderBy: { id: 'asc' },
    });
    await as(api().post(`/api/v1/payment-methods/${cashA}/adjustments`), b)
      .send({
        type: 'TAX',
        label: 'Intruso',
        calculation: 'PERCENT',
        percent: 1,
      })
      .expect(404);
    await as(
      api().patch(`/api/v1/payment-methods/${cashA}/adjustments/${taxId}`),
      b,
    )
      .send({ active: false })
      .expect(404);
    await as(
      api().patch(`/api/v1/payment-methods/${cashB}/adjustments/${taxId}`),
      b,
    )
      .send({ active: false })
      .expect(404);
    expect(
      await raw.paymentMethodAdjustment.findMany({
        where: { tenantId: a.tenantId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before);
    expect(
      await raw.paymentMethodAdjustment.count({
        where: { tenantId: b.tenantId },
      }),
    ).toBe(0);
  });
});
