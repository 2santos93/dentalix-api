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

// DX-402: el caso de la QA de DX-380 (punto 7, caso A) en HTTP real. La
// clínica está en la fuente automática, el proveedor no responde (doble
// CAÍDO que cuenta sus llamadas) y un abono en USD a un plan en COP de hace
// dos días queda «sin tasa» más de 24 h. El ADMIN sigue el aviso: pasa hoy a
// manual (`manualSince` = hoy), ve cuántos abonos de ese día tomarían la tasa
// y registra la tasa COP de ese día. El barrido siguiente congela esa tasa
// como tasa de respaldo, crea la base, quita el aviso y lo deja en la
// auditoría; la tasa congelada ya no cambia. `raw` (DIRECT_URL) solo
// envejece filas y lee.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const PREFIX = `dx402-e2e-${Date.now().toString(36)}`;
const ZONE = 'America/Bogota';
const TODAY = civilDateIn(new Date(), ZONE);
const DAY = addCivilDays(TODAY, -2);
const BACKLOG = '/api/v1/payments/rate-backlog';
const dayPreview = (date: string, currency: string) =>
  `${BACKLOG}/day?date=${date}&currency=${currency}`;

const purgeDay = () =>
  raw.exchangeRateSnapshot.deleteMany({ where: { date: DAY } });

describe('Tasa manual de un día anterior a «manual desde» (e2e, DX-402)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let planId: string;
  let paymentId: string;
  const fetchRates = jest.fn((date: string): Promise<ExchangeRatesResult> =>
    Promise.reject(
      new ExchangeRateUnavailableError(
        `Open Exchange Rates returned 503 for date ${date}`,
      ),
    ),
  );

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, c: Clinic, token = c.adminToken) =>
    req.set('X-Tenant-Host', c.host).set('Authorization', `Bearer ${token}`);
  const sweep = () => app.get(PaymentAllocationJobs).sweep();

  async function seedPlan(c: Clinic): Promise<string> {
    const patient = (
      await as(api().post('/api/v1/patients'), c)
        .send({
          firstName: 'Ana',
          lastName: 'Respaldo',
          docType: 'NATIONAL_ID',
          docNumber: `DX402-${c.tenantId.slice(0, 8)}`,
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    const item = (
      await as(api().post('/api/v1/catalog/items'), c)
        .send({
          code: 'DX402',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 1_000_000,
        })
        .expect(201)
    ).body as { id: string };
    const id = (
      (
        await as(
          api().post(`/api/v1/patients/${patient.id}/treatment-plans`),
          c,
        )
          .send({ notes: 'Plan DX-402', currency: 'COP' })
          .expect(201)
      ).body as { id: string }
    ).id;
    await as(api().post(`/api/v1/treatment-plans/${id}/items`), c)
      .send({ toothNumber: '11', catalogItemId: item.id })
      .expect(201);
    return id;
  }

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder
          .overrideProvider(EXCHANGE_RATE_PROVIDER)
          .useValue({ fetchRates }),
    });
    await purgeDay();
    clinic = await registerClinic(app, `${PREFIX}-a`);
    other = await registerClinic(app, `${PREFIX}-b`);
    planId = await seedPlan(clinic);
    const mine = [clinic.tenantId, other.tenantId];
    const retries = app.get(PaymentBaseRetries);
    const due = retries.dueTenantIds.bind(retries);
    jest
      .spyOn(retries, 'dueTenantIds')
      .mockImplementation(async () =>
        (await due()).filter((id) => mine.includes(id)),
      );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await purgeDay();
    await app.close();
    await raw.$disconnect();
  });

  it('con la fuente automática y el proveedor caído, el abono de hace dos días queda sin tasa y sale el aviso', async () => {
    const payment = (
      await as(api().post(`/api/v1/treatment-plans/${planId}/payments`), clinic)
        .send({
          amount: 50,
          currency: 'USD',
          paidAt: `${DAY}T15:00:00.000Z`,
          method: 'CASH',
        })
        .expect(201)
    ).body as { id: string; exchangeRateStatus: string };
    expect(payment.exchangeRateStatus).toBe('MISSING');
    paymentId = payment.id;
    await sweep();
    // El estado de backoff de la QA: muchos intentos y el siguiente a +20 h.
    const since = new Date(Date.now() - 26 * 3_600_000);
    since.setUTCMilliseconds(0);
    await raw.paymentBaseRetry.updateMany({
      where: { paymentId },
      data: {
        attempts: 5,
        lastReason: 'NO_RATE',
        nextAttemptAt: new Date(Date.now() + 20 * 3_600_000),
        createdAt: since,
      },
    });
    await as(api().get(BACKLOG), clinic)
      .expect(200)
      .expect({ count: 1, oldestSince: since.toISOString() });
  });

  it('pasa a manual hoy; la vista previa del día dice cuántos abonos tomarán la tasa', async () => {
    const settings = await as(api().put('/api/v1/exchange/settings'), clinic)
      .send({ source: 'MANUAL' })
      .expect(200);
    expect(settings.body).toMatchObject({
      source: 'MANUAL',
      manualSince: TODAY,
    });

    await as(api().get(dayPreview(DAY, 'COP')), clinic)
      .expect(200)
      .expect({
        date: DAY,
        currency: 'COP',
        count: 1,
        providerRateSaved: false,
      });
    // Otra moneda, otro día u otra clínica: ninguno.
    await as(api().get(dayPreview(DAY, 'EUR')), clinic)
      .expect(200)
      .expect({
        date: DAY,
        currency: 'EUR',
        count: 0,
        providerRateSaved: false,
      });
    await as(api().get(dayPreview(addCivilDays(DAY, -1), 'COP')), clinic)
      .expect(200)
      .expect((res) => expect((res.body as { count: number }).count).toBe(0));
    await as(api().get(dayPreview(DAY, 'COP')), other)
      .expect(200)
      .expect((res) => expect((res.body as { count: number }).count).toBe(0));
  });

  it('registrar la tasa COP de ese día: el barrido siguiente la congela como respaldo, crea la base y quita el aviso', async () => {
    const calls = fetchRates.mock.calls.length;
    const created = await as(
      api().post('/api/v1/exchange/manual-rates'),
      clinic,
    )
      .send({ date: DAY, currency: 'COP', rate: 4000 })
      .expect(201);
    // El registro adelanta el reintento (DX-380): no espera las 20 h.
    const [retry] = await raw.paymentBaseRetry.findMany({
      where: { paymentId },
    });
    expect(retry.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());

    await sweep();

    expect(
      await raw.paymentBaseRetry.findMany({ where: { paymentId } }),
    ).toEqual([]);
    await as(api().get(BACKLOG), clinic)
      .expect(200)
      .expect({ count: 0, oldestSince: null });
    const frozen = await raw.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    expect(frozen).toMatchObject({
      exchangeRateSource: 'MANUAL',
      exchangeRateDate: new Date(`${DAY}T00:00:00.000Z`),
    });
    expect(Number(frozen.exchangeRateTo)).toBe(4000);
    const base = await raw.paymentPlanAmount.findUniqueOrThrow({
      where: { paymentId },
    });
    expect(Number(base.amount)).toBe(200_000);
    // Con la tasa de ese día registrada no se volvió a pedir al proveedor.
    expect(fetchRates.mock.calls.length).toBe(calls);

    // La auditoría registra que se usó una tasa manual de un día anterior a
    // «manual desde», en el abono y sin usuario (el barrido).
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        resourceId: paymentId,
        action: 'UPDATE',
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'PAYMENT',
        actorUserId: null,
        metadata: {
          reason: 'EXCHANGE_RATE_BACKUP',
          origin: 'JOB',
          exchangeRateBackup: {
            rateDate: DAY,
            manualSince: TODAY,
            currencies: ['COP', 'USD'],
          },
        },
      }),
    ]);
    const listed = await as(
      api().get(`/api/v1/audit-events?resourceType=PAYMENT`),
      clinic,
    ).expect(200);
    expect(JSON.stringify(listed.body)).toContain('EXCHANGE_RATE_BACKUP');

    // Ya no queda ninguno pendiente ese día.
    await as(api().get(dayPreview(DAY, 'COP')), clinic)
      .expect(200)
      .expect((res) => expect((res.body as { count: number }).count).toBe(0));

    // DX-375 intacto: la tasa usada no se corrige y la congelada no cambia.
    const id = (created.body as { id: string }).id;
    const conflict = await as(
      api().put(`/api/v1/exchange/manual-rates/${id}`),
      clinic,
    )
      .send({ rate: 4100 })
      .expect(409);
    expect((conflict.body as { code: string }).code).toBe(
      'MANUAL_EXCHANGE_RATE_IN_USE',
    );
    await sweep();
    expect(
      Number(
        (await raw.payment.findUniqueOrThrow({ where: { id: paymentId } }))
          .exchangeRateTo,
      ),
    ).toBe(4000);
  });

  it('la vista previa es solo del ADMIN y valida el día y la moneda', async () => {
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      const token = await loginAs(app, clinic.host, member.email);
      const denied = await as(
        api().get(dayPreview(DAY, 'COP')),
        clinic,
        token,
      ).expect(403);
      expect((denied.body as { message: string }).message).toBe(
        PAYMENT_RATE_BACKLOG_FORBIDDEN_MESSAGE,
      );
    }
    await as(api().get(dayPreview('2026-02-30', 'COP')), clinic).expect(400);
    await as(api().get(dayPreview(DAY, 'cop1')), clinic).expect(400);
    await as(api().get(`${BACKLOG}/day`), clinic).expect(400);
  });
});
