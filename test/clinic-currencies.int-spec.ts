import { BadRequestException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { AcceptedCurrenciesGate } from '../src/modules/exchange/application/accepted-currencies-gate';
import { GetExchangeHeaderUseCase } from '../src/modules/exchange/application/use-cases/get-exchange-header.use-case';
import { GetRatesForDateUseCase } from '../src/modules/exchange/application/use-cases/get-rates-for-date.use-case';
import { PrismaClinicCurrenciesRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-clinic-currencies.repository';
import { PrismaClinicCurrencyTextsRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-clinic-currency-texts.repository';
import { PrismaClinicExchangeSettingsRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-clinic-exchange-settings.repository';
import { PrismaExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-exchange-rate.repository';
import { PrismaManualExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-manual-exchange-rate.repository';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenants } from './support/tenant-purge';

// DX-584 contra Postgres: las columnas nuevas de `tenants` (CHECK de la lista
// y FK de la referencia), el repositorio (fila bloqueada, evento en la misma
// transacción, un 400 dentro no deja nada), las monedas de las sedes con RLS
// por clínica, la puerta del cobro y la tasa del menú con tasas reales del
// proveedor (cruce vía USD) y manuales (plazo de DX-384).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const currenciesRepo = new PrismaClinicCurrenciesRepository(
  prisma,
  tenantContext,
);
const settingsRepo = new PrismaClinicExchangeSettingsRepository(
  prisma,
  tenantContext,
);
const snapshotsRepo = new PrismaExchangeRateRepository(prisma);
const PREFIX = 'dx584-int';
// Mediodía del 20/11/2026 en Caracas.
const NOW = new Date('2026-11-20T16:00:00.000Z');
const DAY = '2026-11-20';
const PROVIDER = { VES: 918.77, EUR: 0.92 };

const header = new GetExchangeHeaderUseCase(
  currenciesRepo,
  new PrismaClinicCurrencyTextsRepository(prisma, tenantContext),
  settingsRepo,
  snapshotsRepo,
  new GetRatesForDateUseCase(
    snapshotsRepo,
    {
      fetchRates: () => Promise.reject(new Error('el proveedor no se toca')),
    },
    settingsRepo,
    new PrismaManualExchangeRateRepository(prisma, tenantContext),
    tenantContext,
    undefined,
    () => NOW,
  ),
  () => NOW,
);
const gate = new AcceptedCurrenciesGate(currenciesRepo, tenantContext);

interface Clinic {
  tenantId: string;
  userId: string;
  membershipId: string;
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { startsWith: PREFIX } },
    select: { id: true },
  });
  await purgeTenants(
    raw,
    tenants.map((t) => t.id),
  );
  await raw.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

async function seedClinic(
  subdomain: string,
  locationCurrency: string,
): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: {
      name: subdomain,
      subdomain,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  const user = await raw.user.create({
    data: {
      email: `${subdomain}@example.com`,
      fullName: 'Admin',
      passwordHash: 'x',
    },
  });
  const membership = await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'ADMIN' },
  });
  await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: `Sede ${subdomain}`,
      currency: locationCurrency,
    }),
  });
  return {
    tenantId: tenant.id,
    userId: user.id,
    membershipId: membership.id,
  };
}

const ctxOf = (clinic: Clinic): AuditRequestContext => ({
  tenantId: clinic.tenantId,
  locationId: null,
  actor: { userId: clinic.userId, role: 'ADMIN' },
  requestId: 'req-int',
  ip: null,
  userAgent: null,
});

describe('Monedas de la clínica (DX-584, int)', () => {
  let ve: Clinic;
  let other: Clinic;
  const inClinic = <T>(clinic: Clinic, fn: () => Promise<T>) =>
    tenantContext.run(clinic.tenantId, fn);
  const events = (clinic: Clinic) =>
    raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        metadata: { path: ['reason'], equals: 'CLINIC_CURRENCIES' },
      },
    });

  beforeAll(async () => {
    await cleanup();
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
    ve = await seedClinic(`${PREFIX}-ve`, 'VES');
    other = await seedClinic(`${PREFIX}-usd`, 'USD');
  });

  afterAll(async () => {
    await cleanup();
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: DAY, currency: { in: Object.keys(PROVIDER) } },
    });
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  it('una clínica nace sin monedas: lista vacía, sin referencia y automático', async () => {
    await expect(inClinic(ve, () => currenciesRepo.get())).resolves.toEqual({
      acceptedCurrencies: [],
      rateReferenceCurrency: null,
      showRateInHeader: null,
    });
  });

  it('el CHECK rechaza repetidas, minúsculas, más de 8 y NULL; la FK, una referencia fuera del catálogo', async () => {
    const update = (data: Prisma.TenantUncheckedUpdateInput) =>
      raw.tenant.update({ where: { id: ve.tenantId }, data });
    for (const bad of [
      ['USD', 'USD'],
      ['usd'],
      ['USD', 'VES', 'EUR', 'GBP', 'MXN', 'PEN', 'BRL', 'ARS', 'CLP'],
    ]) {
      await expect(update({ acceptedCurrencies: bad })).rejects.toThrow(
        /tenants_accepted_currencies_check/,
      );
    }
    await expect(
      raw.$executeRaw`UPDATE "tenants" SET "acceptedCurrencies" = ARRAY['USD', NULL]::char(3)[] WHERE "id" = ${ve.tenantId}::uuid`,
    ).rejects.toThrow(/tenants_accepted_currencies_check/);
    await expect(update({ rateReferenceCurrency: 'XXX' })).rejects.toThrow();
    await update({ acceptedCurrencies: ['USD', 'VES', 'EUR'] });
    await update({ acceptedCurrencies: [] });
  });

  it('las monedas de las sedes se leen con RLS por clínica', async () => {
    await expect(
      inClinic(ve, () => currenciesRepo.locationCurrencies()),
    ).resolves.toEqual(['VES']);
    await expect(
      inClinic(other, () => currenciesRepo.locationCurrencies()),
    ).resolves.toEqual(['USD']);
    await expect(
      inClinic(ve, () => currenciesRepo.headerLocation()),
    ).resolves.toEqual({ timeZone: 'America/Caracas', currency: 'VES' });
  });

  it('set escribe el evento con el antes y el después en la misma transacción; sin cambio, nada; si `next` lanza, nada', async () => {
    const set = (value: object) =>
      inClinic(ve, () =>
        currenciesRepo.set((before) => ({ ...before, ...value }), ctxOf(ve)),
      );
    await expect(
      set({ acceptedCurrencies: ['USD', 'VES'], rateReferenceCurrency: 'VES' }),
    ).resolves.toMatchObject({
      before: { acceptedCurrencies: [] },
      after: {
        acceptedCurrencies: ['USD', 'VES'],
        rateReferenceCurrency: 'VES',
      },
    });
    await set({ acceptedCurrencies: ['USD', 'VES'] });
    const written = await events(ve);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      resourceId: ve.tenantId,
    });
    expect(written[0].metadata).toMatchObject({
      changedFields: ['acceptedCurrencies', 'rateReferenceCurrency'],
      configChange: {
        before: { acceptedCurrencies: [], rateReferenceCurrency: null },
        after: {
          acceptedCurrencies: ['USD', 'VES'],
          rateReferenceCurrency: 'VES',
        },
      },
    });
    await expect(
      inClinic(ve, () =>
        currenciesRepo.set(() => {
          throw new BadRequestException('no');
        }, ctxOf(ve)),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Un valor que rompe el CHECK tampoco deja evento a medias.
    await expect(set({ acceptedCurrencies: ['USD', 'USD'] })).rejects.toThrow();
    expect(await events(ve)).toHaveLength(1);
    expect(await events(other)).toHaveLength(0);
  });

  it('la puerta del cobro: con lista solo las suyas; la otra clínica (lista vacía) cualquiera', async () => {
    await expect(
      inClinic(ve, () => gate.assertAccepted(['USD', 'VES'])),
    ).resolves.toBeUndefined();
    const error = await inClinic(ve, () => gate.assertAccepted(['EUR'])).catch(
      (e: unknown) => e,
    );
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'CURRENCY_NOT_ACCEPTED',
      currency: 'EUR',
    });
    await expect(
      inClinic(other, () => gate.assertAccepted(['EUR'])),
    ).resolves.toBeUndefined();
  });

  it('el menú: «1 USD = 918,77 VES» con la tasa guardada del proveedor y su hora; la otra clínica no ve nada', async () => {
    const body = await inClinic(ve, () => header.execute());
    expect(body).toMatchObject({
      visible: true,
      reference: 'VES',
      rates: [
        {
          currency: 'USD',
          perReference: 918.77,
          source: 'AUTOMATIC',
          date: DAY,
        },
      ],
      updatedAt: NOW.toISOString(),
    });
    expect(body.rates[0].fetchedAt).toEqual(expect.any(String));
    await expect(
      inClinic(other, () => header.execute()),
    ).resolves.toMatchObject({ visible: false, reference: 'USD', rates: [] });
  });

  it('EUR contra VES cruza vía USD', async () => {
    await raw.tenant.update({
      where: { id: ve.tenantId },
      data: { acceptedCurrencies: ['EUR', 'VES'] },
    });
    const body = await inClinic(ve, () => header.execute());
    expect(body.rates).toEqual([
      expect.objectContaining({
        currency: 'EUR',
        perReference: Number((918.77 / 0.92).toFixed(8)),
      }),
    ]);
  });

  it('MANUAL: la última tasa registrada dentro del plazo; fuera del plazo, sin tasa', async () => {
    await raw.tenant.update({
      where: { id: ve.tenantId },
      data: {
        acceptedCurrencies: ['USD', 'VES'],
        exchangeRateSource: 'MANUAL',
        manualExchangeRatesSince: new Date('2026-11-01T00:00:00Z'),
        manualRateMaxAgeDays: 3,
      },
    });
    await raw.manualExchangeRate.create({
      data: {
        tenantId: ve.tenantId,
        date: new Date('2026-11-18T00:00:00Z'),

        effectiveFrom: new Date('2026-11-18T00:00:00Z'),

        currency: 'VES',
        rate: new Prisma.Decimal('905.5'),
        createdById: ve.userId,
        createdByMembershipId: ve.membershipId,
      },
    });
    await expect(inClinic(ve, () => header.execute())).resolves.toMatchObject({
      visible: true,
      rates: [
        {
          currency: 'USD',
          perReference: 905.5,
          source: 'MANUAL',
          date: '2026-11-18',
          fetchedAt: null,
        },
      ],
    });
    await raw.tenant.update({
      where: { id: ve.tenantId },
      data: { manualRateMaxAgeDays: 1 },
    });
    await expect(inClinic(ve, () => header.execute())).resolves.toMatchObject({
      visible: true,
      rates: [{ perReference: null, source: 'MANUAL', date: DAY }],
    });
  });
});
