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
import {
  MANUAL_RATE_BASE_CURRENCY_MESSAGE,
  MANUAL_RATE_CURRENCY_MESSAGE,
  MANUAL_RATE_DATE_MESSAGE,
  MANUAL_RATE_DUPLICATE_MESSAGE,
  MANUAL_RATE_FUTURE_DATE_MESSAGE,
  MANUAL_RATE_MESSAGE,
} from '../src/modules/exchange/domain/exchange-rate-source';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';

// DX-374 en HTTP real: la fuente de la tasa es por clínica (AUTOMATIC por
// defecto) y solo el ADMIN la cambia y registra tasas manuales; cada cambio
// queda en la auditoría; una tasa registrada no se sobrescribe; dos clínicas
// con fuentes distintas el mismo día leen tasas distintas sin verse. La
// fuente MANUAL rige desde el día en que se elige (revisión): un abono de
// ayer conserva su conversión automática y uno de hoy sin tasa manual queda
// «sin tasa», sin llamar al proveedor (EXCHANGE_APP_ID está vacío en
// .env.test: si se llamara, fallaría) y con el saldo del plan en 200.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

/** Zona de las dos sedes (REGIONAL_BOGOTA_FIXTURE). */
const ZONE = 'America/Bogota';
/** Hoy y ayer en la sede: el paso a MANUAL fija hoy como día de inicio. */
const TODAY = civilDateIn(new Date(), ZONE);
const YESTERDAY = addCivilDays(TODAY, -1);
const SETTINGS = '/api/v1/exchange/settings';
const MANUAL = '/api/v1/exchange/manual-rates';
/** Snapshot del proveedor sembrado para ayer y hoy. */
const PROVIDER = { COP: 4000, VES: 36.5 };

interface RatesBody {
  base: string;
  source: string;
  rates: Record<string, number>;
}

interface ManualRateBody {
  id: string;
  date: string;
  currency: string;
  rate: number;
  createdBy: { userId: string; fullName: string | null };
  createdAt: string;
}

interface AuditItem {
  action: string;
  resourceType: string;
  resourceId: string | null;
  actor: { id: string; role: string } | null;
  metadata: {
    reason?: string;
    statusChange?: { from: string; to: string };
  };
}

interface BalanceBody {
  billable: number;
  paid: number;
  paymentsCount: number;
}

describe('Tasa de cambio por clínica (e2e, DX-374)', () => {
  let app: INestApplication<App>;
  let auto: Clinic;
  let manual: Clinic;
  let planId: string;
  const tokens = {} as Record<ClinicRole, string>;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host: string) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const inManual = (req: request.Test, token = manual.adminToken) =>
    as(req, token, manual.host);
  const rates = async (clinic: Clinic, date: string): Promise<RatesBody> =>
    (
      await as(
        api().get(`/api/v1/exchange/rates?date=${date}`),
        clinic.adminToken,
        clinic.host,
      ).expect(200)
    ).body as RatesBody;
  const events = async (resourceType: string): Promise<AuditItem[]> =>
    (
      (
        await inManual(
          api().get(`/api/v1/audit-events?resourceType=${resourceType}`),
        ).expect(200)
      ).body as { items: AuditItem[] }
    ).items;
  const register = (body: object, token = manual.adminToken) =>
    inManual(api().post(MANUAL), token).send(body);
  const balance = async (): Promise<BalanceBody> =>
    (
      await inManual(
        api().get(`/api/v1/treatment-plans/${planId}/balance`),
      ).expect(200)
    ).body as BalanceBody;
  const payCop = (amount: number, paidAt: string) =>
    inManual(api().post(`/api/v1/treatment-plans/${planId}/payments`))
      .send({ amount, currency: 'COP', paidAt, method: 'CASH' })
      .expect(201);
  const snapshots = () =>
    raw.exchangeRateSnapshot.count({
      where: { date: { in: [YESTERDAY, TODAY] } },
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: [YESTERDAY, TODAY] } },
    });
    await raw.exchangeRateSnapshot.createMany({
      data: [YESTERDAY, TODAY].flatMap((date) =>
        Object.entries(PROVIDER).map(([currency, rate]) => ({
          date,
          currency,
          rate,
        })),
      ),
    });
    auto = await registerClinic(app, 'dx374-auto');
    manual = await registerClinic(app, 'dx374-manual');
    tokens.ADMIN = manual.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, manual, role);
      tokens[role] = await loginAs(app, manual.host, member.email);
    }
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: [YESTERDAY, TODAY] } },
    });
    await app.close();
    await raw.$disconnect();
  });

  it('una clínica nueva está en AUTOMATIC, sin día de inicio, y lee las tasas del proveedor', async () => {
    await inManual(api().get(SETTINGS)).expect(200).expect({
      source: 'AUTOMATIC',
      manualSince: null,
      baseCurrency: 'USD',
    });
    await expect(rates(manual, TODAY)).resolves.toEqual({
      base: 'USD',
      source: 'AUTOMATIC',
      rates: PROVIDER,
    });
  });

  it.each([ClinicRole.DENTIST, ClinicRole.ASSISTANT, ClinicRole.RECEPTION])(
    '%s recibe 403 en español al leer o cambiar la fuente y al registrar o listar tasas',
    async (role) => {
      const token = tokens[role];
      for (const req of [
        inManual(api().get(SETTINGS), token),
        inManual(api().put(SETTINGS), token).send({ source: 'MANUAL' }),
        inManual(api().get(MANUAL), token),
        register({ date: TODAY, currency: 'VES', rate: 40 }, token),
      ]) {
        const res = await req.expect(403);
        expect((res.body as { message: string }).message).toBe(
          EXCHANGE_RATE_SETTINGS_FORBIDDEN_MESSAGE,
        );
      }
      await inManual(api().get(SETTINGS))
        .expect(200)
        .expect((res) => {
          expect((res.body as { source: string }).source).toBe('AUTOMATIC');
        });
    },
  );

  it('los cuatro roles leen las tasas del día de su clínica', async () => {
    for (const role of Object.values(ClinicRole)) {
      await inManual(
        api().get(`/api/v1/exchange/rates?date=${TODAY}`),
        tokens[role],
      ).expect(200);
    }
  });

  it('antes del cambio: un abono en COP de ayer se convierte con la tasa automática', async () => {
    const token = manual.adminToken;
    const host = manual.host;
    const patient = (
      await as(api().post('/api/v1/patients'), token, host)
        .send({
          firstName: 'Ana',
          lastName: 'Tasa',
          docType: 'NATIONAL_ID',
          docNumber: 'DX374-1',
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    const item = (
      await as(api().post('/api/v1/catalog/items'), token, host)
        .send({
          code: 'DX374-RES',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Resina',
          color: '#2A2B3C',
          defaultPrice: 100,
        })
        .expect(201)
    ).body as { id: string };
    planId = (
      (
        await as(
          api().post(`/api/v1/patients/${patient.id}/treatment-plans`),
          token,
          host,
        )
          .send({ notes: 'Plan DX-374', currency: 'USD' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const planItem = (
      await as(
        api().post(`/api/v1/treatment-plans/${planId}/items`),
        token,
        host,
      )
        .send({ toothNumber: '11', catalogItemId: item.id })
        .expect(201)
    ).body as { id: string };
    await as(
      api().patch(`/api/v1/treatment-plans/${planId}/items/${planItem.id}`),
      token,
      host,
    )
      .send({ status: 'DONE' })
      .expect(200);
    // 40.000 COP a 4.000 por USD = 10 USD. 15:00 UTC es ayer también en la sede.
    await payCop(40000, `${YESTERDAY}T15:00:00.000Z`);
    await expect(balance()).resolves.toMatchObject({
      billable: 100,
      paid: 10,
      paymentsCount: 1,
    });
  });

  it('el ADMIN pasa a MANUAL desde hoy; queda en la auditoría y repetirlo no deja otro evento', async () => {
    await inManual(api().put(SETTINGS))
      .send({ source: 'MANUAL' })
      .expect(200)
      .expect({ source: 'MANUAL', manualSince: TODAY, baseCurrency: 'USD' });
    await inManual(api().put(SETTINGS))
      .send({ source: 'MANUAL' })
      .expect(200)
      .expect((res) => {
        expect((res.body as { manualSince: string }).manualSince).toBe(TODAY);
      });
    const settingsEvents = (await events('CLINIC_SETTINGS')).filter(
      (e) => e.metadata.reason === 'EXCHANGE_RATE_SOURCE',
    );
    expect(settingsEvents).toHaveLength(1);
    expect(settingsEvents[0]).toMatchObject({
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      actor: { id: manual.adminUserId, role: 'ADMIN' },
      metadata: { statusChange: { from: 'AUTOMATIC', to: 'MANUAL' } },
    });
  });

  it('pasar a MANUAL no cambia el saldo: el abono de ayer sigue con su tasa automática', async () => {
    await expect(balance()).resolves.toMatchObject({
      paid: 10,
      paymentsCount: 1,
    });
    await expect(rates(manual, YESTERDAY)).resolves.toEqual({
      base: 'USD',
      source: 'AUTOMATIC',
      rates: PROVIDER,
    });
  });

  it('con MANUAL y sin tasa de hoy: `rates` vacío, sin llamar al proveedor, y convertir es 400 EXCHANGE_RATE_MISSING', async () => {
    const before = await snapshots();
    await expect(rates(manual, TODAY)).resolves.toEqual({
      base: 'USD',
      source: 'MANUAL',
      rates: {},
    });
    const res = await inManual(
      api().get(
        `/api/v1/exchange/convert?amount=10&from=USD&to=VES&date=${TODAY}`,
      ),
    ).expect(400);
    expect(res.body).toMatchObject({
      code: 'EXCHANGE_RATE_MISSING',
      message: expect.stringContaining(
        `No hay tasa de VES para el día ${TODAY}`,
      ) as string,
    });
    expect(await snapshots()).toBe(before);
  });

  it('un abono de hoy en COP sin tasa manual se guarda y queda sin tasa; el saldo responde 200', async () => {
    await payCop(80000, new Date(Date.now() - 60_000).toISOString());
    await expect(balance()).resolves.toMatchObject({
      billable: 100,
      paid: 10,
      paymentsCount: 2,
    });
  });

  it('el ADMIN registra la tasa de hoy por moneda; queda en la auditoría', async () => {
    const res = await register({
      date: TODAY,
      currency: 'ves',
      rate: 40.12345678,
    }).expect(201);
    const saved = res.body as ManualRateBody;
    expect(saved).toMatchObject({
      date: TODAY,
      currency: 'VES',
      rate: 40.12345678,
      createdBy: { userId: manual.adminUserId, fullName: 'Dr. Owner' },
    });
    const created = await events('EXCHANGE_RATE');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      action: 'CREATE',
      resourceType: 'EXCHANGE_RATE',
      resourceId: saved.id,
      actor: { id: manual.adminUserId, role: 'ADMIN' },
    });
  });

  it('una tasa ya registrada para ese día y moneda no se sobrescribe: 409 en español', async () => {
    const res = await register({
      date: TODAY,
      currency: 'VES',
      rate: 41,
    }).expect(409);
    expect(res.body).toMatchObject({
      code: 'MANUAL_EXCHANGE_RATE_TAKEN',
      message: MANUAL_RATE_DUPLICATE_MESSAGE,
    });
    const row = await raw.manualExchangeRate.findFirstOrThrow({
      where: { tenantId: manual.tenantId, currency: 'VES' },
    });
    expect(row.rate.toNumber()).toBe(40.12345678);
  });

  it('dos clínicas con fuentes distintas el mismo día leen tasas distintas, sin verse', async () => {
    await expect(rates(auto, TODAY)).resolves.toEqual({
      base: 'USD',
      source: 'AUTOMATIC',
      rates: PROVIDER,
    });
    await expect(rates(manual, TODAY)).resolves.toEqual({
      base: 'USD',
      source: 'MANUAL',
      rates: { VES: 40.12345678 },
    });
    // La clínica automática no ve las tasas manuales de la otra.
    await as(api().get(MANUAL), auto.adminToken, auto.host)
      .expect(200)
      .expect([]);
    const list = (await inManual(api().get(MANUAL)).expect(200))
      .body as ManualRateBody[];
    expect(list.map((r) => `${r.date} ${r.currency}`)).toEqual([
      `${TODAY} VES`,
    ]);
  });

  it.each([
    ['tasa 0', { currency: 'COP', rate: 0 }, MANUAL_RATE_MESSAGE],
    [
      'tasa con 9 decimales',
      { currency: 'COP', rate: 1.123456789 },
      MANUAL_RATE_MESSAGE,
    ],
    ['tasa en texto', { currency: 'COP', rate: '36,5' }, MANUAL_RATE_MESSAGE],
    [
      'moneda fuera de la lista',
      { currency: 'ZZZ', rate: 1 },
      MANUAL_RATE_CURRENCY_MESSAGE,
    ],
    ['USD', { currency: 'USD', rate: 1 }, MANUAL_RATE_BASE_CURRENCY_MESSAGE],
    [
      'fecha que no existe',
      { date: '2026-02-30', currency: 'COP', rate: 1 },
      MANUAL_RATE_DATE_MESSAGE,
    ],
    [
      'fecha con otro formato',
      { date: '02/07/2026', currency: 'COP', rate: 1 },
      MANUAL_RATE_DATE_MESSAGE,
    ],
  ])('%s es 400 en español', async (_label, body, message) => {
    const res = await register({ date: TODAY, ...body }).expect(400);
    expect(JSON.stringify(res.body)).toContain(message);
  });

  it('un día que aún no ha llegado en la zona de la sede es 400', async () => {
    const res = await register({
      date: addCivilDays(TODAY, 1),
      currency: 'COP',
      rate: 1,
    }).expect(400);
    expect(JSON.stringify(res.body)).toContain(MANUAL_RATE_FUTURE_DATE_MESSAGE);
  });

  it('volver a AUTOMATIC limpia el día de inicio y deja de usar las tasas manuales', async () => {
    await inManual(api().put(SETTINGS))
      .send({ source: 'AUTOMATIC' })
      .expect(200)
      .expect({ source: 'AUTOMATIC', manualSince: null, baseCurrency: 'USD' });
    await expect(rates(manual, TODAY)).resolves.toMatchObject({
      source: 'AUTOMATIC',
      rates: PROVIDER,
    });
    // El abono de hoy vuelve a convertirse con la automática: 80.000 / 4.000 = 20.
    await expect(balance()).resolves.toMatchObject({
      paid: 30,
      paymentsCount: 2,
    });
  });
});
