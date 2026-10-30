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
// con fuentes distintas el mismo día leen tasas distintas sin verse; con
// MANUAL y sin tasa del día la moneda queda «sin tasa» sin llamar al
// proveedor (EXCHANGE_APP_ID está vacío en .env.test: si se llamara, fallaría)
// y el saldo del plan responde 200 con el abono sin convertir.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

/** Día con snapshot del proveedor sembrado. */
const DAY = '2026-07-02';
/** Día SIN snapshot del proveedor ni tasa manual. */
const EMPTY_DAY = '2026-07-03';
const SETTINGS = '/api/v1/exchange/settings';
const MANUAL = '/api/v1/exchange/manual-rates';
/** Zona de las dos sedes (REGIONAL_BOGOTA_FIXTURE). */
const ZONE = 'America/Bogota';

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

describe('Tasa de cambio por clínica (e2e, DX-374)', () => {
  let app: INestApplication<App>;
  let auto: Clinic;
  let manual: Clinic;
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

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: [DAY, EMPTY_DAY] } },
    });
    await raw.exchangeRateSnapshot.createMany({
      data: [
        { date: DAY, currency: 'COP', rate: 4000 },
        { date: DAY, currency: 'VES', rate: 36.5 },
      ],
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
      where: { date: { in: [DAY, EMPTY_DAY] } },
    });
    await app.close();
    await raw.$disconnect();
  });

  it('una clínica nueva está en AUTOMATIC y lee las tasas del proveedor', async () => {
    await inManual(api().get(SETTINGS)).expect(200).expect({
      source: 'AUTOMATIC',
    });
    await expect(rates(manual, DAY)).resolves.toEqual({
      base: 'USD',
      source: 'AUTOMATIC',
      rates: { COP: 4000, VES: 36.5 },
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
        register({ date: DAY, currency: 'VES', rate: 40 }, token),
      ]) {
        const res = await req.expect(403);
        expect((res.body as { message: string }).message).toBe(
          EXCHANGE_RATE_SETTINGS_FORBIDDEN_MESSAGE,
        );
      }
      await inManual(api().get(SETTINGS)).expect(200).expect({
        source: 'AUTOMATIC',
      });
    },
  );

  it('los cuatro roles leen las tasas del día de su clínica', async () => {
    for (const role of Object.values(ClinicRole)) {
      await inManual(
        api().get(`/api/v1/exchange/rates?date=${DAY}`),
        tokens[role],
      ).expect(200);
    }
  });

  it('el ADMIN pasa a MANUAL; queda en la auditoría y repetirlo no deja otro evento', async () => {
    await inManual(api().put(SETTINGS))
      .send({ source: 'MANUAL' })
      .expect(200)
      .expect({ source: 'MANUAL' });
    await inManual(api().put(SETTINGS)).send({ source: 'MANUAL' }).expect(200);
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

  it('una fuente desconocida es 400 en español', async () => {
    const res = await inManual(api().put(SETTINGS))
      .send({ source: 'PROVIDER' })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain(
      'Elige de dónde sale la tasa: automática o manual.',
    );
  });

  it('con MANUAL y sin tasa del día: `rates` vacío, sin llamar al proveedor, y convertir es 400 EXCHANGE_RATE_MISSING', async () => {
    await expect(rates(manual, EMPTY_DAY)).resolves.toEqual({
      base: 'USD',
      source: 'MANUAL',
      rates: {},
    });
    expect(
      await raw.exchangeRateSnapshot.count({ where: { date: EMPTY_DAY } }),
    ).toBe(0);
    const res = await inManual(
      api().get(
        `/api/v1/exchange/convert?amount=10&from=USD&to=VES&date=${EMPTY_DAY}`,
      ),
    ).expect(400);
    expect(res.body).toMatchObject({
      code: 'EXCHANGE_RATE_MISSING',
      message: expect.stringContaining(
        'No hay tasa de VES para el día 2026-07-03',
      ) as string,
    });
  });

  it('el ADMIN registra la tasa del día por moneda; queda en la auditoría', async () => {
    const res = await register({
      date: DAY,
      currency: 'ves',
      rate: 40.12345678,
    }).expect(201);
    const saved = res.body as ManualRateBody;
    expect(saved).toMatchObject({
      date: DAY,
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
    const res = await register({ date: DAY, currency: 'VES', rate: 41 }).expect(
      409,
    );
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
    await expect(rates(auto, DAY)).resolves.toEqual({
      base: 'USD',
      source: 'AUTOMATIC',
      rates: { COP: 4000, VES: 36.5 },
    });
    await expect(rates(manual, DAY)).resolves.toEqual({
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
    expect(list.map((r) => `${r.date} ${r.currency}`)).toEqual([`${DAY} VES`]);
  });

  it.each([
    ['tasa 0', { date: DAY, currency: 'COP', rate: 0 }, MANUAL_RATE_MESSAGE],
    [
      'tasa con 9 decimales',
      { date: DAY, currency: 'COP', rate: 1.123456789 },
      MANUAL_RATE_MESSAGE,
    ],
    [
      'tasa en texto',
      { date: DAY, currency: 'COP', rate: '36,5' },
      MANUAL_RATE_MESSAGE,
    ],
    [
      'moneda fuera de la lista',
      { date: DAY, currency: 'ZZZ', rate: 1 },
      MANUAL_RATE_CURRENCY_MESSAGE,
    ],
    [
      'USD',
      { date: DAY, currency: 'USD', rate: 1 },
      MANUAL_RATE_BASE_CURRENCY_MESSAGE,
    ],
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
    const res = await register(body).expect(400);
    expect(JSON.stringify(res.body)).toContain(message);
  });

  it('un día que aún no ha llegado en la zona de la sede es 400', async () => {
    const tomorrow = addCivilDays(civilDateIn(new Date(), ZONE), 1);
    const res = await register({
      date: tomorrow,
      currency: 'COP',
      rate: 1,
    }).expect(400);
    expect(JSON.stringify(res.body)).toContain(MANUAL_RATE_FUTURE_DATE_MESSAGE);
  });

  it('con MANUAL, un abono sin tasa del día se guarda y el saldo del plan responde 200 sin contarlo', async () => {
    const host = manual.host;
    const token = manual.adminToken;
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
    const plan = (
      await as(
        api().post(`/api/v1/patients/${patient.id}/treatment-plans`),
        token,
        host,
      )
        .send({ notes: 'Plan DX-374', currency: 'USD' })
        .expect(201)
    ).body as { id: string };
    const planItem = (
      await as(
        api().post(`/api/v1/treatment-plans/${plan.id}/items`),
        token,
        host,
      )
        .send({ toothNumber: '11', catalogItemId: item.id })
        .expect(201)
    ).body as { id: string };
    await as(
      api().patch(`/api/v1/treatment-plans/${plan.id}/items/${planItem.id}`),
      token,
      host,
    )
      .send({ status: 'DONE' })
      .expect(200);
    // COP el día sin tasa manual (solo hay VES el día DAY).
    await as(
      api().post(`/api/v1/treatment-plans/${plan.id}/payments`),
      token,
      host,
    )
      .send({
        amount: 40000,
        currency: 'COP',
        paidAt: `${EMPTY_DAY}T15:00:00.000Z`,
        method: 'CASH',
      })
      .expect(201);
    const balance = (
      await as(
        api().get(`/api/v1/treatment-plans/${plan.id}/balance`),
        token,
        host,
      ).expect(200)
    ).body as { billable: number; paid: number; paymentsCount: number };
    expect(balance).toMatchObject({ billable: 100, paid: 0, paymentsCount: 1 });
    expect(
      await raw.exchangeRateSnapshot.count({ where: { date: EMPTY_DAY } }),
    ).toBe(0);
  });

  it('volver a AUTOMATIC deja de usar las tasas manuales', async () => {
    await inManual(api().put(SETTINGS))
      .send({ source: 'AUTOMATIC' })
      .expect(200)
      .expect({ source: 'AUTOMATIC' });
    await expect(rates(manual, DAY)).resolves.toMatchObject({
      source: 'AUTOMATIC',
      rates: { COP: 4000, VES: 36.5 },
    });
  });
});
