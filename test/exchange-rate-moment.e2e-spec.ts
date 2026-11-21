import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
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
import { pinCatalogCurrency } from './support/catalog-currency';
import { fixedSedeDay, SEDE_FIXTURE_ZONE } from './support/sede-clock';
import { addCivilDays } from '../src/shared/time/civil-day';
import { EXCHANGE_RATE_CLOCK } from '../src/modules/exchange/application/use-cases/manual-exchange-rates.use-cases';
import { EXCHANGE_REFRESH_MANUAL_MESSAGE } from '../src/modules/exchange/application/use-cases/refresh-exchange-rate.use-case';
import { MANUAL_RATE_IN_USE_MESSAGE } from '../src/modules/exchange/domain/exchange-rate-source';

// DX-586 por HTTP: la tasa «al momento». Un servidor falso en 127.0.0.1 hace
// de BCV (BCV_BASE_URL) y de respaldo (BCV_FALLBACK_BASE_URL): nunca se
// consulta la red real. EXCHANGE_APP_ID está vacío en .env.test.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

/** El día de las pruebas: hace 2 días en la sede (Caracas, UTC−4). */
const DAY = fixedSedeDay(2).day;
const NEXT_DAY = addCivilDays(DAY, 1);
const at = (time: string) => new Date(`${DAY}T${time}:00-04:00`);
/** «Ahora» de la API de tasas: las 16:00 de ese día en la sede. */
const NOW = at('16:00');

const SETTINGS = '/api/v1/exchange/settings';
const MANUAL_RATES = '/api/v1/exchange/manual-rates';
const RATES = '/api/v1/exchange/rates';
const REFRESH = '/api/v1/exchange/refresh';

const FIXTURE_PAGE = readFileSync(
  join(
    __dirname,
    '..',
    'src/modules/exchange/infrastructure/providers/__fixtures__/bcv-home-2026-11-21.html',
  ),
  'utf8',
);
/** La página del BCV publicando la fecha valor `valueDate`. */
const page = (valueDate: string) =>
  FIXTURE_PAGE.replace(
    'content="2026-11-24T00:00:00-04:00"',
    `content="${valueDate}T00:00:00-04:00"`,
  );
/** El respaldo (dolarapi) con su `fechaActualizacion` en `day`. */
const fallback = (day: string, usd: number, eur: number) => ({
  '/fallback/v1/dolares/oficial': {
    status: 200,
    body: JSON.stringify({
      fuente: 'oficial',
      promedio: usd,
      fechaActualizacion: `${day}T09:00:00-04:00`,
    }),
  },
  '/fallback/v1/euros': {
    status: 200,
    body: JSON.stringify([
      {
        fuente: 'oficial',
        promedio: eur,
        fechaActualizacion: `${day}T09:00:00-04:00`,
      },
    ]),
  },
});

interface PaymentBody {
  id: string;
  exchangeRateStatus: string;
  frozenRate: {
    fromPerBase: number;
    source: string;
    ref: string | null;
    valueDate: string | null;
    quotedAt: string | null;
  } | null;
  rateUsed: {
    rate: number;
    unit: string;
    currency: string;
    source: string;
    valueDate: string | null;
    quotedAt: string;
    ref: string;
  } | null;
}

describe('Tasa al momento (e2e, DX-586)', () => {
  let app: INestApplication<App>;
  let bcvClinic: Clinic;
  let manualClinic: Clinic;
  let bcvPlan: string;
  let manualPlan: string;
  let reception: string;
  let dentist: string;
  let manualReception: string;
  let stub: Server;
  let stubRoutes: Record<string, { status: number; body: string }> = {};
  const savedEnv = process.env.BCV_BASE_URL;
  const savedFallbackEnv = process.env.BCV_FALLBACK_BASE_URL;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);

  async function planIn(clinic: Clinic, tag: string): Promise<string> {
    const patient = (
      await as(api().post('/api/v1/patients'), clinic)
        .send({
          firstName: 'Rosa',
          lastName: 'Mérida',
          docType: 'NATIONAL_ID',
          docNumber: `DX586-${tag}`,
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    await pinCatalogCurrency(raw, clinic.tenantId, 'USD');
    const item = (
      await as(api().post('/api/v1/catalog/items'), clinic)
        .send({
          code: `DX586-${tag}`,
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 1000,
        })
        .expect(201)
    ).body as { id: string };
    const plan = (
      await as(
        api().post(`/api/v1/patients/${patient.id}/treatment-plans`),
        clinic,
      )
        .send({ notes: 'Plan DX-586', currency: 'USD' })
        .expect(201)
    ).body as { id: string };
    const planItem = (
      await as(api().post(`/api/v1/treatment-plans/${plan.id}/items`), clinic)
        .send({ toothNumber: '11', catalogItemId: item.id })
        .expect(201)
    ).body as { id: string };
    await as(
      api().patch(`/api/v1/treatment-plans/${plan.id}/items/${planItem.id}`),
      clinic,
    )
      .send({ status: 'DONE' })
      .expect(200);
    return plan.id;
  }

  const pay = async (clinic: Clinic, plan: string, paidAt: Date) =>
    (
      await as(api().post(`/api/v1/treatment-plans/${plan}/payments`), clinic)
        .send({
          amount: 9187.7,
          currency: 'VES',
          paidAt: paidAt.toISOString(),
          method: 'CASH',
        })
        .expect(201)
    ).body as PaymentBody;

  const registerRate = async (rate: number, effectiveFrom: string) =>
    (
      await as(api().post(MANUAL_RATES), manualClinic)
        .send({ date: DAY, currency: 'VES', rate, effectiveFrom })
        .expect(201)
    ).body as { id: string; effectiveFrom: string };

  /** Libera el turno de «Actualizar tasa» (una vez cada 5 min). */
  const freeRefresh = (clinic: Clinic) =>
    raw.tenant.update({
      where: { id: clinic.tenantId },
      data: { exchangeRateRefreshedAt: null },
    });

  beforeAll(async () => {
    stub = createServer((req, res) => {
      const route = stubRoutes[req.url ?? ''] ?? { status: 404, body: '' };
      res.writeHead(route.status, { 'content-type': 'text/html' });
      res.end(route.body);
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    process.env.BCV_BASE_URL = `${base}/bcv`;
    process.env.BCV_FALLBACK_BASE_URL = `${base}/fallback`;

    app = await createE2eApp({
      override: (builder) =>
        builder.overrideProvider(EXCHANGE_RATE_CLOCK).useValue(() => NOW),
    });
    await resetDatabase(raw);
    bcvClinic = await registerClinic(app, 'dx586-bcv');
    manualClinic = await registerClinic(app, 'dx586-manual');
    reception = await loginAs(
      app,
      bcvClinic.host,
      (await seedMember(raw, bcvClinic, ClinicRole.RECEPTION)).email,
    );
    dentist = await loginAs(
      app,
      bcvClinic.host,
      (await seedMember(raw, bcvClinic, ClinicRole.DENTIST)).email,
    );
    manualReception = await loginAs(
      app,
      manualClinic.host,
      (await seedMember(raw, manualClinic, ClinicRole.RECEPTION)).email,
    );
    bcvPlan = await planIn(bcvClinic, 'BCV');
    manualPlan = await planIn(manualClinic, 'MANUAL');
    await as(api().put(SETTINGS), bcvClinic)
      .send({ source: 'BCV', acceptedCurrencies: ['USD', 'VES'] })
      .expect(200);
    await raw.tenant.update({
      where: { id: manualClinic.tenantId },
      data: {
        exchangeRateSource: 'MANUAL',
        manualExchangeRatesSince: new Date(
          `${addCivilDays(DAY, -10)}T00:00:00Z`,
        ),
        manualRateMaxAgeDays: 0,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await resetDatabase(raw);
    await app?.close();
    await raw.$disconnect();
    stub.closeAllConnections();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    if (savedEnv === undefined) delete process.env.BCV_BASE_URL;
    else process.env.BCV_BASE_URL = savedEnv;
    if (savedFallbackEnv === undefined)
      delete process.env.BCV_FALLBACK_BASE_URL;
    else process.env.BCV_FALLBACK_BASE_URL = savedFallbackEnv;
  });

  describe('varias tasas manuales el mismo día', () => {
    let early: { id: string };
    let late: { id: string };
    let first: PaymentBody;
    let second: PaymentBody;

    beforeAll(async () => {
      early = await registerRate(918.77, `${DAY}T08:00:00-04:00`);
      late = await registerRate(920.1, `${DAY}T14:30:00-04:00`);
      first = await pay(manualClinic, manualPlan, at('10:00'));
      second = await pay(manualClinic, manualPlan, at('15:00'));
    });

    it('el abono de las 10:00 usa la de las 08:00 y el de las 15:00 la de las 14:30, con su referencia y su instante', () => {
      expect(first).toMatchObject({
        exchangeRateStatus: 'FROZEN',
        frozenRate: {
          fromPerBase: 918.77,
          source: 'MANUAL',
          ref: `MANUAL:${early.id}`,
          valueDate: null,
        },
        rateUsed: {
          rate: 918.77,
          unit: 'USD',
          currency: 'VES',
          source: 'MANUAL',
          valueDate: null,
          ref: `MANUAL:${early.id}`,
        },
      });
      expect(second.frozenRate).toMatchObject({
        fromPerBase: 920.1,
        ref: `MANUAL:${late.id}`,
      });
      // El instante lo pone la BD al congelar: el de ahora, no el del abono.
      const quotedAt = new Date(first.rateUsed!.quotedAt).getTime();
      expect(Math.abs(quotedAt - Date.now())).toBeLessThan(5 * 60_000);
    });

    it('GET /exchange/rates (recepción): la vigente ahora y la lista del día, sin autor ni uso', async () => {
      const res = await as(
        api().get(`${RATES}?date=${DAY}&currencies=VES`),
        manualClinic,
        manualReception,
      ).expect(200);
      const body = res.body as {
        rates: Record<string, number>;
        manualRates: { id: string }[];
        manualDay: Record<string, unknown>[];
      };
      expect(body.rates).toEqual({ VES: 920.1 });
      expect(body.manualRates.map((r) => r.id)).toEqual([late.id]);
      expect(body.manualDay.map((r) => r.id)).toEqual([early.id, late.id]);
      for (const row of body.manualDay) {
        expect(Object.keys(row).sort()).toEqual([
          'currency',
          'date',
          'effectiveFrom',
          'id',
          'rate',
        ]);
      }
    });

    it('una tasa usada no se corrige; otra del mismo día y moneda sin usar sí (por su referencia)', async () => {
      const used = await as(
        api().put(`${MANUAL_RATES}/${early.id}`),
        manualClinic,
      )
        .send({ rate: 919 })
        .expect(409);
      expect((used.body as { message: string }).message).toBe(
        MANUAL_RATE_IN_USE_MESSAGE,
      );
      const unused = await registerRate(921, `${DAY}T15:30:00-04:00`);
      await as(api().put(`${MANUAL_RATES}/${unused.id}`), manualClinic)
        .send({ rate: 921.5 })
        .expect(200);
    });

    it('el recibo y la caja traen la tasa usada', async () => {
      const receipt = await as(
        api().get(`/api/v1/payments/${first.id}/receipt`),
        manualClinic,
      ).expect(200);
      expect(
        (receipt.body as { exchangeRate: { rateUsed: unknown } }).exchangeRate
          .rateUsed,
      ).toMatchObject({ ref: `MANUAL:${early.id}`, rate: 918.77 });
      const cash = await as(
        api().get(`/api/v1/payments?from=${DAY}&to=${DAY}`),
        manualClinic,
      ).expect(200);
      const row = (
        cash.body as { items: { id: string; rateUsed: unknown }[] }
      ).items.find((item) => item.id === second.id);
      expect(row?.rateUsed).toMatchObject({ ref: `MANUAL:${late.id}` });
    });

    it('con tasa manual, «Actualizar tasa» es 409 con el mensaje en español', async () => {
      const res = await as(api().post(REFRESH), manualClinic, manualReception)
        .send({})
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'EXCHANGE_RATE_REFRESH_MANUAL',
        message: EXCHANGE_REFRESH_MANUAL_MESSAGE,
      });
    });
  });

  describe('fuente BCV: «Actualizar tasa»', () => {
    it('el DENTIST no cobra: 403 y no gasta el turno', async () => {
      await as(api().post(REFRESH), bcvClinic, dentist).send({}).expect(403);
      const tenant = await raw.tenant.findUniqueOrThrow({
        where: { id: bcvClinic.tenantId },
      });
      expect(tenant.exchangeRateRefreshedAt).toBeNull();
    });

    it('recepción consulta el BCV en el acto: guarda la tasa, audita y devuelve el indicador', async () => {
      stubRoutes = { '/bcv/': { status: 200, body: page(DAY) } };
      const res = await as(api().post(REFRESH), bcvClinic, reception)
        .send({})
        .expect(200);
      expect(res.body).toMatchObject({
        visible: true,
        reference: 'VES',
        rates: [
          {
            currency: 'USD',
            source: 'BCV',
            valueDate: DAY,
            perReference: 919.8227,
          },
        ],
      });
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: bcvClinic.tenantId,
          metadata: { path: ['reason'], equals: 'EXCHANGE_RATE_REFRESH' },
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: bcvClinic.tenantId,
      });
    });

    it('otra vez antes de 5 min: 429 «Vuelve a intentarlo en 5 min» con Retry-After', async () => {
      const res = await as(api().post(REFRESH), bcvClinic, reception)
        .send({})
        .expect(429);
      expect(res.body).toMatchObject({
        code: 'EXCHANGE_RATE_REFRESH_TOO_SOON',
        message: 'Vuelve a intentarlo en 5 min.',
      });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(200);
    });

    it('un abono en VES congela la tasa del BCV con su fecha valor y su referencia', async () => {
      const payment = await pay(bcvClinic, bcvPlan, at('15:00'));
      expect(payment).toMatchObject({
        frozenRate: { source: 'BCV', ref: `BCV:${DAY}`, valueDate: DAY },
        rateUsed: {
          rate: 919.8227,
          unit: 'USD',
          currency: 'VES',
          source: 'BCV',
          valueDate: DAY,
          ref: `BCV:${DAY}`,
        },
      });
    });

    it('la página oficial caída: el respaldo da la tasa (FALLBACK)', async () => {
      await freeRefresh(bcvClinic);
      await raw.bcvRateSnapshot.deleteMany({});
      stubRoutes = {
        '/bcv/': { status: 500, body: 'caído' },
        ...fallback(DAY, 919.5, 1012),
      };
      await as(api().post(REFRESH), bcvClinic, reception).send({}).expect(200);
      const saved = await raw.bcvRateSnapshot.findMany();
      expect(saved.map((s) => [s.origin, Number(s.usdVes)])).toEqual([
        ['FALLBACK', 919.5],
      ]);
    });

    it('arranque en frío: el BCV ya publica mañana y no hay tasa de hoy: guarda también la vigente del respaldo', async () => {
      await freeRefresh(bcvClinic);
      await raw.bcvRateSnapshot.deleteMany({});
      stubRoutes = {
        '/bcv/': { status: 200, body: page(NEXT_DAY) },
        ...fallback(DAY, 917.62, 1009.5),
      };
      const res = await as(api().post(REFRESH), bcvClinic, reception)
        .send({})
        .expect(200);
      const saved = await raw.bcvRateSnapshot.findMany({
        orderBy: { valueDate: 'asc' },
      });
      expect(
        saved.map((s) => [s.valueDate.toISOString().slice(0, 10), s.origin]),
      ).toEqual([
        [DAY, 'FALLBACK'],
        [NEXT_DAY, 'BCV'],
      ]);
      // Hoy rige la vigente del respaldo, no la de mañana.
      expect(res.body).toMatchObject({
        rates: [{ currency: 'USD', valueDate: DAY, perReference: 917.62 }],
      });
    });

    it('el BCV y su respaldo caídos: 503 en español', async () => {
      await freeRefresh(bcvClinic);
      stubRoutes = { '/bcv/': { status: 500, body: 'caído' } };
      const res = await as(api().post(REFRESH), bcvClinic, reception)
        .send({})
        .expect(503);
      expect(res.body).toMatchObject({ code: 'EXCHANGE_RATE_UNAVAILABLE' });
    });
  });

  it('el turno es por clínica: el de una no frena a la otra (la zona de la sede es Caracas)', async () => {
    expect(SEDE_FIXTURE_ZONE).toBe('America/Caracas');
    await freeRefresh(bcvClinic);
    stubRoutes = { '/bcv/': { status: 200, body: page(DAY) } };
    await as(api().post(REFRESH), bcvClinic, reception).send({}).expect(200);
    const other = await raw.tenant.findUniqueOrThrow({
      where: { id: manualClinic.tenantId },
    });
    expect(other.exchangeRateRefreshedAt).toBeNull();
  });
});
