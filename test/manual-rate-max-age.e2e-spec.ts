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
import { EXCHANGE_RATE_SETTINGS_FORBIDDEN_MESSAGE } from '../src/modules/exchange/presentation/exchange-settings.controller';
import { MANUAL_RATE_MAX_AGE_MESSAGE } from '../src/modules/exchange/domain/manual-rate-fallback';
import { EXCHANGE_RATE_CLOCK } from '../src/modules/exchange/application/use-cases/manual-exchange-rates.use-cases';
import { addCivilDays } from '../src/shared/time/civil-day';
import { fixedSedeDay } from './support/sede-clock';
import { PaymentAllocationJobs } from '../src/modules/payments/application/payment-allocation-jobs';
import { pinCatalogCurrency } from './support/catalog-currency';

// DX-384 en HTTP real: con fuente MANUAL, el abono de un día sin tasa congela
// la última tasa registrada dentro del plazo de la clínica (N días; 3 por
// defecto, 0 = solo el día exacto) y la devuelve con su fecha. Dos clínicas
// con la misma tasa del «viernes» y N=3 / N=0 dan resultados distintos el
// «sábado». Solo el ADMIN lee y cambia el plazo (validado 0..30, auditado).
// «Sábado» = hoy (el día fijo de la API) y «viernes» = ayer. EXCHANGE_APP_ID
// está vacío en .env.test: si se llamara al proveedor, fallaría.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// «Manual desde» es el viernes (la API ve ese día como «hoy» al pasar a MANUAL):
// una tasa anterior a ese día no cuenta para el plazo. Luego el reloj pasa al sábado.
const FRIDAY_DAY = fixedSedeDay(2);
const SEDE_DAY = fixedSedeDay(1);
const SATURDAY = SEDE_DAY.day;
const FRIDAY = FRIDAY_DAY.day;
let clockAt = FRIDAY_DAY.at;
const SETTINGS = '/api/v1/exchange/settings';
const MANUAL_RATES = '/api/v1/exchange/manual-rates';

interface PaymentBody {
  id: string;
  exchangeRateStatus: string;
  frozenRate: {
    currency: string;
    fromPerBase: number;
    toPerBase: number;
    source: string;
    date: string;
  } | null;
}

interface BalanceBody {
  paid: number;
  paymentsWithoutRate: { paymentId: string }[];
}

interface AuditItem {
  action: string;
  metadata: {
    reason?: string;
    changedFields?: string[];
    configChange?: {
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    };
  };
}

describe('Tasa manual de respaldo hasta N días (e2e, DX-384)', () => {
  let app: INestApplication<App>;
  let withDefault: Clinic;
  let exact: Clinic;
  const plans = new Map<string, string>();
  const tokens = {} as Record<ClinicRole, string>;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const putSettings = (clinic: Clinic, body: object, token?: string) =>
    as(api().put(SETTINGS), clinic, token).send(body);
  const register = (clinic: Clinic, date: string, rate: number) =>
    as(api().post(MANUAL_RATES), clinic)
      .send({ date, currency: 'EUR', rate })
      .expect(201);
  const pay = async (clinic: Clinic, amount: number): Promise<PaymentBody> =>
    (
      await as(
        api().post(
          `/api/v1/treatment-plans/${plans.get(clinic.tenantId)}/payments`,
        ),
        clinic,
      )
        .send({
          amount,
          currency: 'EUR',
          paidAt: SEDE_DAY.before(60).toISOString(),
          method: 'CASH',
        })
        .expect(201)
    ).body as PaymentBody;
  const balance = async (clinic: Clinic): Promise<BalanceBody> =>
    (
      await as(
        api().get(
          `/api/v1/treatment-plans/${plans.get(clinic.tenantId)}/balance`,
        ),
        clinic,
      ).expect(200)
    ).body as BalanceBody;
  const rawPayment = (id: string) =>
    raw.payment.findUniqueOrThrow({
      where: { id },
      select: {
        exchangeRateSource: true,
        exchangeRateDate: true,
        exchangeRateFrom: true,
      },
    });

  async function seedPlan(clinic: Clinic, tag: string): Promise<void> {
    const patient = (
      await as(api().post('/api/v1/patients'), clinic)
        .send({
          firstName: 'Ana',
          lastName: 'Respaldo',
          docType: 'NATIONAL_ID',
          docNumber: `DX384-${tag}`,
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    // DX-513-bis: el catálogo en la moneda de los planes del spec (USD): sus
    // ítems no necesitan tasa y sus importes no cambian (support/catalog-currency).
    await pinCatalogCurrency(raw, clinic.tenantId, 'USD');
    const item = (
      await as(api().post('/api/v1/catalog/items'), clinic)
        .send({
          code: `DX384-${tag}`,
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
          .send({ notes: 'Plan DX-384', currency: 'USD' })
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
    plans.set(clinic.tenantId, planId);
  }

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder.overrideProvider(EXCHANGE_RATE_CLOCK).useValue(() => clockAt),
    });
    await resetDatabase(raw);
    withDefault = await registerClinic(app, 'dx384-default');
    exact = await registerClinic(app, 'dx384-exact');
    tokens.ADMIN = withDefault.adminToken;
    const reception = await seedMember(raw, withDefault, ClinicRole.RECEPTION);
    tokens.RECEPTION = await loginAs(app, withDefault.host, reception.email);
    await seedPlan(withDefault, 'D');
    await seedPlan(exact, 'E');
    for (const clinic of [withDefault, exact]) {
      await putSettings(clinic, { source: 'MANUAL' }).expect(200);
      // La misma tasa del «viernes» en las dos clínicas.
      await register(clinic, FRIDAY, 4000);
    }
    // A partir de aquí «hoy» es el sábado.
    clockAt = SEDE_DAY.at;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('el plazo es 3 días por defecto y el ADMIN lo lee', async () => {
    const res = await as(api().get(SETTINGS), withDefault).expect(200);
    expect(res.body).toMatchObject({
      source: 'MANUAL',
      manualRateMaxAgeDays: 3,
      baseCurrency: 'USD',
    });
  });

  it('RECEPTION recibe 403 en español al leer o cambiar el plazo', async () => {
    for (const req of [
      as(api().get(SETTINGS), withDefault, tokens.RECEPTION),
      putSettings(withDefault, { manualRateMaxAgeDays: 1 }, tokens.RECEPTION),
    ]) {
      const res = await req.expect(403);
      expect((res.body as { message: string }).message).toBe(
        EXCHANGE_RATE_SETTINGS_FORBIDDEN_MESSAGE,
      );
    }
    await expect(
      as(api().get(SETTINGS), withDefault).then((r) => r.body as unknown),
    ).resolves.toMatchObject({ manualRateMaxAgeDays: 3 });
  });

  it.each([-1, 31, 1.5, 'tres'])(
    'un plazo %p es 400 en español y no cambia nada',
    async (bad) => {
      const res = await putSettings(withDefault, {
        manualRateMaxAgeDays: bad,
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain(MANUAL_RATE_MAX_AGE_MESSAGE);
      await expect(
        as(api().get(SETTINGS), withDefault).then((r) => r.body as unknown),
      ).resolves.toMatchObject({ manualRateMaxAgeDays: 3 });
    },
  );

  it('sin ningún campo es 400', async () => {
    await putSettings(withDefault, {}).expect(400);
  });

  it('GET /exchange/rates: con monedas pedidas devuelve la tasa del viernes y su fecha; sin ellas, solo el día', async () => {
    await expect(
      as(
        api().get(`/api/v1/exchange/rates?date=${SATURDAY}&currencies=eur,USD`),
        withDefault,
      ).then((r) => r.body as unknown),
    ).resolves.toEqual({
      base: 'USD',
      source: 'MANUAL',
      rates: { EUR: 4000 },
      rateDate: FRIDAY,
    });
    await expect(
      as(
        api().get(`/api/v1/exchange/rates?date=${SATURDAY}`),
        withDefault,
      ).then((r) => r.body as unknown),
    ).resolves.toEqual({
      base: 'USD',
      source: 'MANUAL',
      rates: {},
      rateDate: SATURDAY,
    });
    await as(
      api().get(`/api/v1/exchange/rates?date=${SATURDAY}&currencies=EURO`),
      withDefault,
    ).expect(400);
  });

  it('una tasa anterior a «manual desde» no sirve al plazo (es el respaldo de DX-402 de su día)', async () => {
    const thursday = addCivilDays(FRIDAY, -1);
    await as(api().post(MANUAL_RATES), withDefault)
      .send({ date: thursday, currency: 'GBP', rate: 0.8 })
      .expect(201);
    await expect(
      as(
        api().get(`/api/v1/exchange/rates?date=${SATURDAY}&currencies=GBP`),
        withDefault,
      ).then((r) => r.body as unknown),
    ).resolves.toEqual({
      base: 'USD',
      source: 'MANUAL',
      rates: {},
      rateDate: SATURDAY,
    });
  });

  it('el sábado, N=3 usa la tasa del viernes y N=0 queda «sin tasa»', async () => {
    await putSettings(exact, { manualRateMaxAgeDays: 0 }).expect(200);

    const sat3 = await pay(withDefault, 40000);
    expect(sat3).toMatchObject({
      exchangeRateStatus: 'FROZEN',
      frozenRate: {
        currency: 'USD',
        fromPerBase: 4000,
        toPerBase: 1,
        source: 'MANUAL',
        date: FRIDAY,
      },
    });
    await expect(balance(withDefault)).resolves.toMatchObject({
      paid: 10,
      paymentsWithoutRate: [],
    });
    await expect(rawPayment(sat3.id)).resolves.toMatchObject({
      exchangeRateSource: 'MANUAL',
    });

    const sat0 = await pay(exact, 40000);
    expect(sat0).toMatchObject({
      exchangeRateStatus: 'MISSING',
      frozenRate: null,
    });
    await expect(balance(exact)).resolves.toMatchObject({
      paid: 0,
      paymentsWithoutRate: [{ paymentId: sat0.id }],
    });
  });

  it('la tasa del viernes que congeló el abono del sábado ya no se corrige (409)', async () => {
    const listed = (await as(api().get(MANUAL_RATES), withDefault).expect(200))
      .body as { id: string; date: string; inUse: boolean }[];
    const friday = listed.find((r) => r.date === FRIDAY);
    expect(friday?.inUse).toBe(true);
    await as(api().put(`${MANUAL_RATES}/${friday?.id}`), withDefault)
      .send({ rate: 4100 })
      .expect(409);
  });

  it('registrar después la tasa del sábado no cambia el abono ya congelado; el siguiente usa la del día', async () => {
    const [first] = await raw.payment.findMany({
      where: { tenantId: withDefault.tenantId },
      select: { id: true },
    });
    await register(withDefault, SATURDAY, 5000);
    await app.get(PaymentAllocationJobs).sweep();

    const frozen = await rawPayment(first.id);
    expect(Number(frozen.exchangeRateFrom)).toBe(4000);
    expect(frozen.exchangeRateDate?.toISOString().slice(0, 10)).toBe(FRIDAY);
    await expect(balance(withDefault)).resolves.toMatchObject({ paid: 10 });

    const next = await pay(withDefault, 50000);
    expect(next.frozenRate).toMatchObject({
      fromPerBase: 5000,
      date: SATURDAY,
    });
    await expect(balance(withDefault)).resolves.toMatchObject({ paid: 20 });
  });

  it('subir el plazo de la clínica con N=0 hace que el barrido congele el abono «sin tasa» con la del viernes', async () => {
    await putSettings(exact, { manualRateMaxAgeDays: 3 }).expect(200);
    await app.get(PaymentAllocationJobs).sweep();
    await expect(balance(exact)).resolves.toMatchObject({
      paid: 10,
      paymentsWithoutRate: [],
    });
    const [only] = await raw.payment.findMany({
      where: { tenantId: exact.tenantId },
      select: { id: true },
    });
    const frozen = await rawPayment(only.id);
    expect(frozen.exchangeRateSource).toBe('MANUAL');
    expect(frozen.exchangeRateDate?.toISOString().slice(0, 10)).toBe(FRIDAY);
  });

  it('cada cambio del plazo queda en la auditoría con el antes y el después; sin cambio, sin evento', async () => {
    await putSettings(exact, { manualRateMaxAgeDays: 3 }).expect(200);
    const items = (
      (
        await as(
          api().get('/api/v1/audit-events?resourceType=CLINIC_SETTINGS'),
          exact,
        ).expect(200)
      ).body as { items: AuditItem[] }
    ).items.filter((e) => e.metadata.reason === 'EXCHANGE_RATE_MAX_AGE');
    // 3 → 0 y 0 → 3; el último PUT (3 → 3) no escribió nada.
    expect(items).toHaveLength(2);
    expect(items.map((e) => e.metadata.configChange)).toEqual(
      expect.arrayContaining([
        {
          before: { manualRateMaxAgeDays: 3 },
          after: { manualRateMaxAgeDays: 0 },
        },
        {
          before: { manualRateMaxAgeDays: 0 },
          after: { manualRateMaxAgeDays: 3 },
        },
      ]),
    );
    for (const e of items) {
      expect(e.action).toBe('UPDATE');
      expect(e.metadata.changedFields).toEqual(['manualRateMaxAgeDays']);
    }
  });
});
