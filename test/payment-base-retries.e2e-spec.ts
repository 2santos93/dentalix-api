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
  loginAs,
  registerClinic,
  seedMember,
  type Clinic,
} from './support/e2e-fixtures';
import {
  EXCHANGE_RATE_PROVIDER,
  ExchangeRateUnavailableError,
  type ExchangeRatesResult,
} from '../src/modules/exchange/domain/ports/exchange-rate-provider.port';
import { PaymentAllocationJobs } from '../src/modules/payments/application/payment-allocation-jobs';
import { PaymentBaseRetries } from '../src/modules/payments/application/payment-base-retries';
import { PAYMENT_RATE_BACKLOG_FORBIDDEN_MESSAGE } from '../src/modules/payments/presentation/payment-rate-backlog.controller';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';

// DX-380 en HTTP real, con un doble del proveedor de tasas CAÍDO que cuenta
// sus llamadas (nunca sale a la red): N clínicas cobran en COP a un plan en
// USD el mismo día sin snapshot. El alta y los barridos piden ese día al
// proveedor UNA vez en todo el sistema (caché negativa de SEC-054) y los
// abonos quedan «sin tasa» con su reintento escalonado, sin 500. Una clínica
// en MANUAL no llama nunca. El ADMIN ve el aviso de abonos sin tasa pasadas
// 24 h (los demás roles, 403) y desaparece al registrar la tasa, que adelanta
// el reintento. `raw` (DIRECT_URL) solo envejece filas, cambia la fuente y
// limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// Sufijo por ejecución: el registro no admite repetir subdominio.
const PREFIX = `dx380-e2e-${Date.now().toString(36)}`;
const ZONE = 'America/Bogota';
const DAY = addCivilDays(civilDateIn(new Date(), ZONE), -2);
const N = 4;
const BACKLOG = '/api/v1/payments/rate-backlog';

/** Solo el snapshot del día: las clínicas llevan un sufijo por ejecución. */
const purgeDay = () =>
  raw.exchangeRateSnapshot.deleteMany({ where: { date: DAY } });

describe('Abonos sin tasa con el proveedor caído (e2e, DX-380)', () => {
  let app: INestApplication<App>;
  const clinics: Clinic[] = [];
  let manual: Clinic;
  const plans = new Map<string, string>();
  const fetchRates = jest.fn((date: string): Promise<ExchangeRatesResult> =>
    Promise.reject(
      new ExchangeRateUnavailableError(
        `Open Exchange Rates returned 503 for date ${date}`,
      ),
    ),
  );

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const mine = () => [...clinics, manual].map((c) => c.tenantId);

  async function seedPlan(clinic: Clinic, tag: string): Promise<void> {
    const patient = (
      await as(api().post('/api/v1/patients'), clinic)
        .send({
          firstName: 'Ana',
          lastName: 'Sin Tasa',
          docType: 'NATIONAL_ID',
          docNumber: `DX380-${tag}`,
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    const item = (
      await as(api().post('/api/v1/catalog/items'), clinic)
        .send({
          code: `DX380-${tag}`,
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
          .send({ notes: 'Plan DX-380', currency: 'USD' })
          .expect(201)
      ).body as { id: string }
    ).id;
    await as(api().post(`/api/v1/treatment-plans/${planId}/items`), clinic)
      .send({ toothNumber: '11', catalogItemId: item.id })
      .expect(201);
    plans.set(clinic.tenantId, planId);
  }

  const pay = async (clinic: Clinic) =>
    (
      await as(
        api().post(
          `/api/v1/treatment-plans/${plans.get(clinic.tenantId)}/payments`,
        ),
        clinic,
      )
        .send({
          amount: 40000,
          currency: 'COP',
          paidAt: `${DAY}T15:00:00.000Z`,
          method: 'CASH',
        })
        .expect(201)
    ).body as { id: string; exchangeRateStatus: string };

  /** Un barrido de cada minuto (las clínicas, acotadas en beforeAll). */
  const sweep = () => app.get(PaymentAllocationJobs).sweep();

  const retriesOf = (tenantId: string) =>
    raw.paymentBaseRetry.findMany({ where: { tenantId } });

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder
          .overrideProvider(EXCHANGE_RATE_PROVIDER)
          .useValue({ fetchRates }),
    });
    await purgeDay();
    for (let i = 0; i < N; i += 1) {
      const clinic = await registerClinic(app, `${PREFIX}-${i}`);
      await seedPlan(clinic, `${i}`);
      clinics.push(clinic);
    }
    manual = await registerClinic(app, `${PREFIX}-manual`);
    await seedPlan(manual, 'M');
    await raw.tenant.update({
      where: { id: manual.tenantId },
      data: {
        exchangeRateSource: 'MANUAL',
        manualExchangeRatesSince: new Date(`${DAY}T00:00:00.000Z`),
      },
    });
    // La consulta real de clínicas con pendientes, acotada a las de esta
    // suite (la BD de test es compartida).
    const retries = app.get(PaymentBaseRetries);
    const due = retries.dueTenantIds.bind(retries);
    jest
      .spyOn(retries, 'dueTenantIds')
      .mockImplementation(async () =>
        (await due()).filter((id) => mine().includes(id)),
      );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await purgeDay();
    await app.close();
    await raw.$disconnect();
  });

  it('N clínicas el mismo día sin tasa: una llamada al proveedor en todo el sistema, abonos «sin tasa» y reintento escalonado', async () => {
    for (const clinic of clinics) {
      const payment = await pay(clinic);
      expect(payment.exchangeRateStatus).toBe('MISSING');
    }
    expect(fetchRates.mock.calls).toEqual([[DAY]]);

    // Primer barrido: los N se intentan (y fallan como «sin tasa», no 500)
    // sin otra llamada; quedan aplazados 1 min.
    await sweep();
    expect(fetchRates).toHaveBeenCalledTimes(1);
    for (const clinic of clinics) {
      const [row] = await retriesOf(clinic.tenantId);
      expect(row).toMatchObject({ attempts: 1, lastReason: 'NO_RATE' });
    }

    // Barridos seguidos: nadie ha vencido su minuto, nada se reintenta.
    await sweep();
    await sweep();
    expect(fetchRates).toHaveBeenCalledTimes(1);
    for (const clinic of clinics) {
      expect((await retriesOf(clinic.tenantId))[0].attempts).toBe(1);
    }

    // Vencido el minuto: segundo intento, con el día aún en la caché
    // negativa (1 h): sin llamar.
    await raw.paymentBaseRetry.updateMany({
      where: { tenantId: { in: clinics.map((c) => c.tenantId) } },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    await sweep();
    expect(fetchRates).toHaveBeenCalledTimes(1);
    for (const clinic of clinics) {
      expect((await retriesOf(clinic.tenantId))[0].attempts).toBe(2);
    }
  });

  it('una clínica en MANUAL sin la tasa del día no llama nunca al proveedor', async () => {
    const calls = fetchRates.mock.calls.length;
    const payment = await pay(manual);
    expect(payment.exchangeRateStatus).toBe('MISSING');
    await sweep();

    expect(fetchRates.mock.calls.length).toBe(calls);
    expect(await retriesOf(manual.tenantId)).toEqual([
      expect.objectContaining({ attempts: 1, lastReason: 'NO_RATE' }),
    ]);
  });

  it('el ADMIN ve el aviso pasadas 24 h, otros roles no, y desaparece al registrar la tasa', async () => {
    const [first, second] = clinics;
    const since = new Date(Date.now() - 26 * 3_600_000);
    since.setUTCMilliseconds(0);
    await raw.paymentBaseRetry.updateMany({
      where: { tenantId: first.tenantId },
      data: { createdAt: since },
    });

    const shown = await as(api().get(BACKLOG), first).expect(200);
    expect(shown.body).toEqual({ count: 1, oldestSince: since.toISOString() });
    // Otra clínica con abonos sin tasa de menos de 24 h: sin aviso.
    await as(api().get(BACKLOG), second)
      .expect(200)
      .expect({ count: 0, oldestSince: null });

    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, first, role);
      const token = await loginAs(app, first.host, member.email);
      const denied = await as(api().get(BACKLOG), first, token).expect(403);
      expect((denied.body as { message: string }).message).toBe(
        PAYMENT_RATE_BACKLOG_FORBIDDEN_MESSAGE,
      );
    }

    // La clínica pasa a MANUAL desde ese día y registra la tasa: el
    // reintento se adelanta y el barrido siguiente lo resuelve.
    await raw.tenant.update({
      where: { id: first.tenantId },
      data: {
        exchangeRateSource: 'MANUAL',
        manualExchangeRatesSince: new Date(`${DAY}T00:00:00.000Z`),
      },
    });
    const calls = fetchRates.mock.calls.length;
    await as(api().post('/api/v1/exchange/manual-rates'), first)
      .send({ date: DAY, currency: 'COP', rate: 4000 })
      .expect(201);
    await sweep();

    expect(await retriesOf(first.tenantId)).toEqual([]);
    await as(api().get(BACKLOG), first)
      .expect(200)
      .expect({ count: 0, oldestSince: null });
    const base = await raw.paymentPlanAmount.findFirstOrThrow({
      where: { tenantId: first.tenantId },
    });
    expect(Number(base.amount)).toBe(10);
    expect(fetchRates.mock.calls.length).toBe(calls);
  });
});
