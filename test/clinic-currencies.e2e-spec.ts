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
import { EXCHANGE_RATE_CLOCK } from '../src/modules/exchange/application/use-cases/manual-exchange-rates.use-cases';
import { EXCHANGE_RATE_SETTINGS_FORBIDDEN_MESSAGE } from '../src/modules/exchange/presentation/exchange-settings.controller';

// DX-584 por HTTP: las monedas de la clínica (solo ADMIN, validadas y
// auditadas), la tasa del menú para cualquier miembro (con «1 USD = N Bs.»
// cruzado vía USD, la fuente de la clínica y sin tasa → null) y el cobro que
// rechaza una moneda fuera de la lista (suelto, dividido y vuelto); lista
// vacía = como antes. La sede del fixture es de Caracas, en VES.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SEDE_DAY = fixedSedeDay(1);
const DAY = SEDE_DAY.day;
const SETTINGS = '/api/v1/exchange/settings';
const HEADER = '/api/v1/exchange/header';
/** Tasas del proveedor del día (por 1 USD). */
const PROVIDER = { VES: 36.5, EUR: 0.92 };

interface HeaderBody {
  visible: boolean;
  reference: string | null;
  referenceLabel: string | null;
  rates: {
    currency: string;
    perReference: number | null;
    label: string | null;
    source: string;
    date: string;
    fetchedAt: string | null;
  }[];
  acceptedCurrencies: string[];
  updatedAt: string;
}

describe('Monedas de la clínica y tasa del menú (e2e, DX-584)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let plan: string;
  let cash: string;
  let mobile: string;
  const tokens = {} as Record<ClinicRole, string>;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const put = (body: object, token = a.adminToken) =>
    as(api().put(SETTINGS), a, token).send(body);
  const header = async (clinic: Clinic, token = clinic.adminToken) =>
    (await as(api().get(HEADER), clinic, token).expect(200)).body as HeaderBody;
  const auditOf = () =>
    raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        metadata: { path: ['reason'], equals: 'CLINIC_CURRENCIES' },
      },
      orderBy: { occurredAt: 'asc' },
    });
  const pay = (body: Record<string, unknown>) =>
    as(
      api().post(`/api/v1/treatment-plans/${plan}/payments`),
      a,
      tokens.RECEPTION,
    ).send({ paidAt: DAY, paymentMethodId: cash, ...body });
  const split = (lines: Record<string, unknown>[]) =>
    as(
      api().post(`/api/v1/treatment-plans/${plan}/split-payments`),
      a,
      tokens.RECEPTION,
    ).send({ paidAt: DAY, confirmCreditBalance: true, lines });
  const paymentsOfPlan = () =>
    raw.payment.count({ where: { treatmentPlanId: plan } });

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder
          .overrideProvider(EXCHANGE_RATE_CLOCK)
          .useValue(() => SEDE_DAY.at),
    });
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: DAY, currency: { in: Object.keys(PROVIDER) } },
    });
    await raw.exchangeRateSnapshot.createMany({
      data: Object.entries(PROVIDER).map(([currency, rate]) => ({
        date: DAY,
        currency,
        rate,
      })),
    });
    a = await registerClinic(app, 'dx584-a');
    b = await registerClinic(app, 'dx584-b');
    tokens.ADMIN = a.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      tokens[role] = await loginAs(
        app,
        a.host,
        (await seedMember(raw, a, role)).email,
      );
    }
    const methods = (
      await as(api().get('/api/v1/payment-methods'), a).expect(200)
    ).body as { id: string; legacyMethod: string | null }[];
    cash = methods.find((m) => m.legacyMethod === 'CASH')!.id;
    mobile = (
      (
        await as(api().post('/api/v1/payment-methods'), a)
          .send({
            name: 'Pago móvil',
            kind: 'DIGITAL',
            requiresReference: true,
          })
          .expect(201)
      ).body as { id: string }
    ).id;

    const patient = (
      await as(api().post('/api/v1/patients'), a)
        .send({
          firstName: 'Rosa',
          lastName: 'Moneda',
          docType: 'NATIONAL_ID',
          docNumber: 'DX584-E2E',
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    await pinCatalogCurrency(raw, a.tenantId, 'USD');
    const item = (
      await as(api().post('/api/v1/catalog/items'), a)
        .send({
          code: 'DX584-E2E',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Resina',
          color: '#2A2B3C',
          defaultPrice: 500,
        })
        .expect(201)
    ).body as { id: string };
    plan = (
      (
        await as(
          api().post(`/api/v1/patients/${patient.id}/treatment-plans`),
          a,
        )
          .send({ notes: 'Plan DX-584', currency: 'USD' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const planItem = (
      await as(api().post(`/api/v1/treatment-plans/${plan}/items`), a)
        .send({ toothNumber: '21', catalogItemId: item.id })
        .expect(201)
    ).body as { id: string };
    await as(
      api().patch(`/api/v1/treatment-plans/${plan}/items/${planItem.id}`),
      a,
    )
      .send({ status: 'DONE' })
      .expect(200);
  }, 120_000);

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: DAY, currency: { in: Object.keys(PROVIDER) } },
    });
    await app.close();
    await raw.$disconnect();
  });

  it('una clínica nueva no tiene monedas configuradas y el menú no enseña nada', async () => {
    const res = await as(api().get(SETTINGS), a).expect(200);
    expect(res.body).toMatchObject({
      acceptedCurrencies: [],
      rateReferenceCurrency: null,
      showRateInHeader: null,
    });
    await expect(header(a)).resolves.toMatchObject({
      visible: false,
      reference: 'VES',
      rates: [],
    });
  });

  it.each([ClinicRole.DENTIST, ClinicRole.ASSISTANT, ClinicRole.RECEPTION])(
    '%s no cambia las monedas (403 en español) pero lee la tasa del menú',
    async (role) => {
      const res = await put(
        { acceptedCurrencies: ['USD'] },
        tokens[role],
      ).expect(403);
      expect((res.body as { message: string }).message).toBe(
        EXCHANGE_RATE_SETTINGS_FORBIDDEN_MESSAGE,
      );
      await as(api().get(HEADER), a, tokens[role]).expect(200);
      expect(await auditOf()).toHaveLength(0);
    },
  );

  it('validación: catálogo, repetidas, más de 8, null, referencia que no es aceptada ni de una sede y booleano', async () => {
    const message = async (body: object) =>
      ((await put(body).expect(400)).body as { message: string | string[] })
        .message;
    await expect(
      message({ acceptedCurrencies: ['USD', 'XYZ'] }),
    ).resolves.toEqual(expect.stringContaining('XYZ'));
    await expect(message({ acceptedCurrencies: ['USD', 'usd'] })).resolves.toBe(
      'USD aparece más de una vez en las monedas aceptadas.',
    );
    await put({
      acceptedCurrencies: [
        'USD',
        'VES',
        'EUR',
        'GBP',
        'MXN',
        'PEN',
        'BRL',
        'ARS',
        'CLP',
      ],
    }).expect(400);
    await put({ acceptedCurrencies: null }).expect(400);
    await put({ acceptedCurrencies: ['DOLAR'] }).expect(400);
    await expect(
      message({ acceptedCurrencies: ['USD'], rateReferenceCurrency: 'EUR' }),
    ).resolves.toBe(
      'La moneda de referencia (EUR) tiene que ser una de las monedas aceptadas o la moneda de alguna sede.',
    );
    await put({ showRateInHeader: 'si' }).expect(400);
    expect(await auditOf()).toHaveLength(0);
    expect((await as(api().get(SETTINGS), a).expect(200)).body).toMatchObject({
      acceptedCurrencies: [],
    });
  });

  it('el ADMIN acepta USD y VES (VES de referencia): queda en la auditoría y repetirlo no deja otro evento', async () => {
    const res = await put({
      acceptedCurrencies: ['usd', 'VES'],
      rateReferenceCurrency: 'VES',
    }).expect(200);
    expect(res.body).toMatchObject({
      source: 'AUTOMATIC',
      baseCurrency: 'USD',
      acceptedCurrencies: ['USD', 'VES'],
      rateReferenceCurrency: 'VES',
      showRateInHeader: null,
    });
    const events = await auditOf();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      resourceId: a.tenantId,
    });
    expect(events[0].metadata).toMatchObject({
      configChange: {
        before: {
          acceptedCurrencies: [],
          rateReferenceCurrency: null,
        },
        after: {
          acceptedCurrencies: ['USD', 'VES'],
          rateReferenceCurrency: 'VES',
        },
      },
    });
    await put({
      acceptedCurrencies: ['USD', 'VES'],
      rateReferenceCurrency: 'VES',
    }).expect(200);
    expect(await auditOf()).toHaveLength(1);
  });

  it('el menú enseña «1 USD = 36,5 VES» a los cuatro roles, con el texto propio de la moneda; la otra clínica no ve nada', async () => {
    await as(api().put('/api/v1/exchange/currency-texts'), a)
      .send({ entries: [{ currency: 'VES', text: 'Bs.' }] })
      .expect(200);
    for (const role of Object.values(ClinicRole)) {
      await expect(header(a, tokens[role])).resolves.toMatchObject({
        visible: true,
        reference: 'VES',
        referenceLabel: 'Bs.',
        rates: [
          {
            currency: 'USD',
            perReference: 36.5,
            label: null,
            source: 'AUTOMATIC',
            date: DAY,
            fetchedAt: expect.any(String) as string,
          },
        ],
      });
    }
    await expect(header(b)).resolves.toMatchObject({
      visible: false,
      rates: [],
      acceptedCurrencies: [],
    });
    // Recepción lee la lista entera (con la de referencia) para el cobro.
    await expect(header(a, tokens.RECEPTION)).resolves.toMatchObject({
      acceptedCurrencies: ['USD', 'VES'],
    });
  });

  it('EUR se cruza vía USD y una moneda sin tasa del proveedor sale con null', async () => {
    await put({ acceptedCurrencies: ['EUR', 'GBP', 'VES'] }).expect(200);
    const body = await header(a);
    expect(body.rates.map((r) => [r.currency, r.perReference])).toEqual([
      ['EUR', Number((36.5 / 0.92).toFixed(8))],
      ['GBP', null],
    ]);
    expect(body.rates[1].fetchedAt).toBeNull();
  });

  it('«Nunca» lo oculta y «Siempre» sin monedas aceptadas enseña la del USD', async () => {
    await put({ showRateInHeader: false }).expect(200);
    await expect(header(a)).resolves.toMatchObject({
      visible: false,
      rates: [],
    });
    await put({
      acceptedCurrencies: [],
      rateReferenceCurrency: null,
      showRateInHeader: true,
    }).expect(200);
    await expect(header(a)).resolves.toMatchObject({
      visible: true,
      reference: 'VES',
      rates: [{ currency: 'USD', perReference: 36.5 }],
    });
    await put({ showRateInHeader: null }).expect(200);
    await expect(header(a)).resolves.toMatchObject({ visible: false });
  });

  it('con MANUAL, la tasa registrada del día', async () => {
    await put({
      source: 'MANUAL',
      acceptedCurrencies: ['USD', 'VES'],
    }).expect(200);
    await as(api().post('/api/v1/exchange/manual-rates'), a)
      .send({ date: DAY, currency: 'VES', rate: 40 })
      .expect(201);
    await expect(header(a)).resolves.toMatchObject({
      visible: true,
      rates: [
        {
          currency: 'USD',
          perReference: 40,
          source: 'MANUAL',
          date: DAY,
          fetchedAt: null,
        },
      ],
    });
    await put({ source: 'AUTOMATIC' }).expect(200);
  });

  describe('cobro', () => {
    beforeAll(async () => {
      await put({
        acceptedCurrencies: ['USD'],
        rateReferenceCurrency: null,
        showRateInHeader: null,
      }).expect(200);
    });

    it('abono suelto en una moneda no aceptada: 400 CURRENCY_NOT_ACCEPTED y nada registrado; en USD, 201', async () => {
      const before = await paymentsOfPlan();
      const res = await pay({ amount: 365, currency: 'VES' }).expect(400);
      expect(res.body).toMatchObject({
        code: 'CURRENCY_NOT_ACCEPTED',
        currency: 'VES',
        message:
          'Esta clínica no acepta pagos en VES. Cambia las monedas en Ajustes.',
      });
      expect(await paymentsOfPlan()).toBe(before);
      await pay({ amount: 10, currency: 'USD' }).expect(201);
      expect(await paymentsOfPlan()).toBe(before + 1);
    });

    it('cobro dividido con una línea no aceptada: 400 y ninguna línea registrada', async () => {
      const before = await paymentsOfPlan();
      const res = await split([
        { amount: 5, currency: 'USD', paymentMethodId: cash },
        {
          amount: 182.5,
          currency: 'VES',
          paymentMethodId: mobile,
          reference: 'PM-584',
        },
      ]).expect(400);
      expect(res.body).toMatchObject({ code: 'CURRENCY_NOT_ACCEPTED' });
      expect(await paymentsOfPlan()).toBe(before);
    });

    it('vuelto en una moneda no aceptada: 400 y nada registrado', async () => {
      const before = await paymentsOfPlan();
      const res = await pay({
        amount: 45,
        currency: 'USD',
        tendered: 50,
        change: [
          {
            paymentMethodId: mobile,
            currency: 'VES',
            amount: 182.5,
            reference: '0412-5551234',
          },
        ],
      }).expect(400);
      expect(res.body).toMatchObject({
        code: 'CURRENCY_NOT_ACCEPTED',
        currency: 'VES',
      });
      expect(await paymentsOfPlan()).toBe(before);
    });

    it('los abonos ya registrados no cambian y, con la lista vacía, se cobra en cualquier moneda como antes', async () => {
      await put({ acceptedCurrencies: [] }).expect(200);
      const before = await paymentsOfPlan();
      await pay({ amount: 365, currency: 'VES' }).expect(201);
      await split([
        { amount: 5, currency: 'USD', paymentMethodId: cash },
        {
          amount: 182.5,
          currency: 'VES',
          paymentMethodId: mobile,
          reference: 'PM-584-B',
        },
      ]).expect(201);
      expect(await paymentsOfPlan()).toBe(before + 3);
    });
  });
});
