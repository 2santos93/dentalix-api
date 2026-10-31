import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { CURRENCY_DIGITS } from '../prisma/reference/currency-digits';
import {
  oldBillable,
  oldPlanTotal,
} from '../src/shared/money/__fixtures__/pre-dx340-oracle';
import { PAYMENT_CLOCK } from '../src/modules/payments/application/use-cases/void-payment.use-case';
import {
  type Clinic,
  createE2eApp,
  registerClinic,
  resetDatabase,
} from './support/e2e-fixtures';

// DX-340: una sola regla de redondeo (cada línea a los decimales de su
// moneda, total = suma de líneas). Con Postgres de verdad: la tabla
// `currencies` migrada coincide con la referencia versionada, GET
// /currencies y el detalle del plan exponen los decimales, y para un plan
// JPY y uno EUR con descuento en bloque del 7,5 % el detalle del plan,
// `/balance`, el estado de cuenta y el recibo dan el mismo total. (DX-472
// unifica el CÁLCULO del saldo; aquí solo se comprueba que el redondeo
// cuadra entre documentos.) Reloj de los abonos inyectado.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const PAYMENT_NOW = new Date('2026-10-31T15:00:00.000Z');

interface PlanCase {
  currency: 'JPY' | 'EUR';
  prices: number[];
  /** Descuento esperado por ítem al 7,5 % (redondeado a la unidad). */
  discounts: number[];
  total: number;
  payment: number;
}

const CASES: PlanCase[] = [
  {
    // 7,5 % de 12 345 = 925,875 → 926; de 8 001 = 600,075 → 600;
    // de 99 = 7,425 → 7. Total = Σ(precio − descuento) = 18 912.
    currency: 'JPY',
    prices: [12345, 8001, 99],
    discounts: [926, 600, 7],
    total: 18912,
    payment: 5000,
  },
  {
    // 7,5 % de 123,45 = 9,25875 → 9,26; de 0,99 = 0,07425 → 0,07;
    // de 80,01 = 6,00075 → 6,00. Total = 189,12.
    currency: 'EUR',
    prices: [123.45, 0.99, 80.01],
    discounts: [9.26, 0.07, 6],
    total: 189.12,
    payment: 50.5,
  },
];

describe('DX-340: redondeo único por línea (e2e)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let patientId: string;
  let catalogItemId: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);

  beforeAll(async () => {
    app = await createE2eApp((builder) => {
      builder.overrideProvider(PAYMENT_CLOCK).useValue(() => PAYMENT_NOW);
    });
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx340');
    const patient = await as(api().post('/api/v1/patients'))
      .send({
        firstName: 'Redondeo',
        lastName: 'Único',
        docType: 'NATIONAL_ID',
        docNumber: 'DX340-001',
        sex: Sex.F,
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
    const catalog = await as(api().post('/api/v1/catalog/items'))
      .send({
        code: 'DX340-RES',
        kind: 'PROCEDURE',
        labelEs: 'Resina',
        color: '#2A2B3C',
      })
      .expect(201);
    catalogItemId = (catalog.body as { id: string }).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('la tabla currencies migrada es la referencia versionada (sin lista fija en el código)', async () => {
    const rows = await raw.currency.findMany({
      where: { code: { in: CURRENCY_DIGITS.map((c) => c.code) } },
      select: { code: true, minorUnits: true, roundingDigits: true },
      orderBy: { code: 'asc' },
    });
    expect(rows).toEqual(
      [...CURRENCY_DIGITS].sort((a, b) => a.code.localeCompare(b.code)),
    );
  });

  it('una moneda de 3 decimales se rechaza en la BD (Decimal(14,2))', async () => {
    await expect(
      raw.currency.create({
        data: {
          code: 'KWD',
          name: 'Dinar kuwaití',
          symbol: 'KWD',
          minorUnits: 3,
          roundingDigits: 3,
        },
      }),
    ).rejects.toThrow(/currencies_minor_units_check/);
  });

  it('GET /currencies expone minor units ISO y dígitos de redondeo', async () => {
    const res = await as(api().get('/api/v1/currencies')).expect(200);
    const byCode = new Map(
      (res.body as { code: string }[]).map((c) => [c.code, c] as const),
    );
    expect(byCode.get('JPY')).toMatchObject({
      minorUnits: 0,
      roundingDigits: 0,
    });
    expect(byCode.get('EUR')).toMatchObject({
      minorUnits: 2,
      roundingDigits: 2,
    });
    // RSD: ISO 2, se sigue redondeando a 0 (decisión pendiente del dueño).
    expect(byCode.get('RSD')).toMatchObject({
      minorUnits: 2,
      roundingDigits: 0,
    });
    expect(byCode.get('COP')).toMatchObject({
      minorUnits: 2,
      roundingDigits: 0,
    });
  });

  it.each(CASES)(
    '$currency: plan, /balance, estado de cuenta y recibo dan el mismo total',
    async ({ currency, prices, discounts, total, payment }) => {
      const plan = await as(
        api().post(`/api/v1/patients/${patientId}/treatment-plans`),
      )
        .send({ currency })
        .expect(201);
      const planId = (plan.body as { id: string }).id;
      const itemIds: string[] = [];
      for (const [i, price] of prices.entries()) {
        const item = await as(
          api().post(`/api/v1/treatment-plans/${planId}/items`),
        )
          .send({ toothNumber: String(11 + i), catalogItemId, price })
          .expect(201);
        itemIds.push((item.body as { id: string }).id);
      }
      const bulk = await as(
        api().post(`/api/v1/treatment-plans/${planId}/items/bulk-discount`),
      )
        .send({ itemIds, percent: 7.5 })
        .expect(200);
      const discounted = new Map(
        (bulk.body as { items: { id: string; discount: number }[] }).items.map(
          (i) => [i.id, i.discount] as const,
        ),
      );
      expect(itemIds.map((id) => discounted.get(id))).toEqual(discounts);
      for (const id of itemIds) {
        await as(api().patch(`/api/v1/treatment-plans/${planId}/items/${id}`))
          .send({ status: 'ACCEPTED' })
          .expect(200);
      }

      const detail = await as(
        api().get(`/api/v1/treatment-plans/${planId}`),
      ).expect(200);
      expect(detail.body).toMatchObject({
        total,
        currencyDigits:
          currency === 'JPY'
            ? { minorUnits: 0, roundingDigits: 0 }
            : { minorUnits: 2, roundingDigits: 2 },
      });

      const paid = await as(
        api().post(`/api/v1/treatment-plans/${planId}/payments`),
      )
        .send({
          amount: payment,
          currency,
          paidAt: '2026-10-31',
          method: 'CASH',
        })
        .expect(201);
      const paymentId = (paid.body as { id: string }).id;

      const balance = await as(
        api().get(`/api/v1/treatment-plans/${planId}/balance`),
      ).expect(200);
      const statement = await as(
        api().get(`/api/v1/patients/${patientId}/account-statement`),
      ).expect(200);
      const receipt = await as(
        api().get(`/api/v1/payments/${paymentId}/receipt`),
      ).expect(200);

      const pending = Math.round((total - payment) * 100) / 100;
      expect(balance.body).toMatchObject({
        billable: total,
        paid: payment,
        balance: pending,
      });
      const line = (
        statement.body as {
          plans: { id: string; budgeted: number; balance: number }[];
        }
      ).plans.find((p) => p.id === planId);
      expect(line).toMatchObject({ budgeted: total, balance: pending });
      expect(
        (
          receipt.body as {
            snapshot: { planBalance: Record<string, unknown> | null };
          }
        ).snapshot.planBalance,
      ).toEqual({ currency, billable: total, paid: payment, balance: pending });
    },
  );

  // Revisión DX-340 (M2): con ítems no cobrables (PROPOSED) y descuentos
  // manuales con céntimos (también en JPY, que los campos admiten: DX-241),
  // el estado de cuenta (Σ en SQL real) = `/balance` = lo que daba main
  // (oráculo congelado), y el detalle del plan = total de main.
  it.each([
    {
      currency: 'JPY',
      lines: [
        { price: 12345, discount: 12.34, status: 'ACCEPTED' as const },
        { price: 1000.5, discount: 0.99, status: 'DONE' as const },
        { price: 999, discount: 0.01, status: 'PROPOSED' as const },
      ],
    },
    {
      currency: 'EUR',
      lines: [
        { price: 0.1, discount: 0, status: 'ACCEPTED' as const },
        { price: 0.2, discount: 0.01, status: 'DONE' as const },
        { price: 123.45, discount: 9.25, status: 'ACCEPTED' as const },
        { price: 50, discount: 1, status: 'PROPOSED' as const },
      ],
    },
    {
      currency: 'RSD',
      lines: [
        { price: 123.45, discount: 9, status: 'ACCEPTED' as const },
        { price: 99.99, discount: 0.99, status: 'DONE' as const },
        { price: 10, discount: 0, status: 'PROPOSED' as const },
      ],
    },
  ])(
    '$currency: estado de cuenta (SQL) = /balance = main, con ítems no cobrables y descuentos con céntimos',
    async ({ currency, lines }) => {
      const plan = await as(
        api().post(`/api/v1/patients/${patientId}/treatment-plans`),
      )
        .send({ currency })
        .expect(201);
      const planId = (plan.body as { id: string }).id;
      for (const [i, line] of lines.entries()) {
        const item = await as(
          api().post(`/api/v1/treatment-plans/${planId}/items`),
        )
          .send({
            toothNumber: String(31 + i),
            catalogItemId,
            price: line.price,
            discount: line.discount,
          })
          .expect(201);
        if (line.status !== 'PROPOSED') {
          const id = (item.body as { id: string }).id;
          await as(api().patch(`/api/v1/treatment-plans/${planId}/items/${id}`))
            .send({ status: line.status })
            .expect(200);
        }
      }
      const billable = oldBillable(lines);
      const detail = await as(
        api().get(`/api/v1/treatment-plans/${planId}`),
      ).expect(200);
      expect((detail.body as { total: number }).total).toBe(
        oldPlanTotal(lines),
      );
      const balance = await as(
        api().get(`/api/v1/treatment-plans/${planId}/balance`),
      ).expect(200);
      expect((balance.body as { billable: number }).billable).toBe(billable);
      const statement = await as(
        api().get(`/api/v1/patients/${patientId}/account-statement`),
      ).expect(200);
      const line = (
        statement.body as { plans: { id: string; budgeted: number }[] }
      ).plans.find((p) => p.id === planId);
      expect(line?.budgeted).toBe(billable);
    },
  );
});
