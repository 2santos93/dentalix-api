import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { GetRatesForDateUseCase } from '../src/modules/exchange/application/use-cases/get-rates-for-date.use-case';
import { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import { MissingExchangeRateError } from '../src/modules/exchange/domain/missing-exchange-rate.error';
import { PrismaExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-exchange-rate.repository';
import { PrismaClinicExchangeSettingsRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-clinic-exchange-settings.repository';
import { PrismaManualExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-manual-exchange-rate.repository';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { purgeTenants } from './support/tenant-purge';

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

// DX-384, contra Postgres: dos clínicas con la MISMA tasa manual del viernes
// 30/10/2026 y plazos distintos (3 y 0) resuelven distinto el sábado; las
// lecturas de tasas por rango van con RLS FORCE por clínica (una clínica no ve
// las tasas de la otra); el plazo es un CHECK 0..30 con 3 por defecto y su
// cambio deja el evento con el antes y el después en la misma transacción.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const settingsRepo = new PrismaClinicExchangeSettingsRepository(
  prisma,
  tenantContext,
);
const manualRepo = new PrismaManualExchangeRateRepository(
  prisma,
  tenantContext,
);
const convert = new ConvertAmountUseCase(
  new GetRatesForDateUseCase(
    new PrismaExchangeRateRepository(prisma),
    {
      fetchRates: () => Promise.reject(new Error('el proveedor no se toca')),
    },
    settingsRepo,
    manualRepo,
    tenantContext,
  ),
);

const PREFIX = 'dx384-int';
const FRIDAY = '2026-10-30';
const SATURDAY = '2026-10-31';
const MONDAY = '2026-11-02';
const TUESDAY = '2026-11-03';

interface Clinic {
  tenantId: string;
  userId: string;
}

async function seedClinic(
  subdomain: string,
  maxAgeDays: number | undefined,
): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: {
      name: subdomain,
      subdomain,
      exchangeRateSource: 'MANUAL',
      manualExchangeRatesSince: new Date('2026-10-01T00:00:00Z'),
      ...(maxAgeDays === undefined ? {} : { manualRateMaxAgeDays: maxAgeDays }),
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
  await raw.manualExchangeRate.create({
    data: {
      tenantId: tenant.id,
      date: new Date(`${FRIDAY}T00:00:00Z`),
      currency: 'VES',
      rate: new Prisma.Decimal('36.5'),
      createdById: user.id,
      createdByMembershipId: membership.id,
    },
  });
  return { tenantId: tenant.id, userId: user.id };
}

const ctxOf = (clinic: Clinic): AuditRequestContext => ({
  tenantId: clinic.tenantId,
  locationId: null,
  actor: { userId: clinic.userId, role: 'ADMIN' },
  requestId: 'req-int',
  ip: null,
  userAgent: null,
});

describe('plazo de la última tasa manual (DX-384, int)', () => {
  let defaults: Clinic;
  let exact: Clinic;

  const quote = (clinic: Clinic, date: string) =>
    tenantContext.run(clinic.tenantId, () =>
      convert.quote({ from: 'VES', to: 'USD', date }),
    );

  beforeAll(async () => {
    await cleanup();
    defaults = await seedClinic(`${PREFIX}-default`, undefined);
    exact = await seedClinic(`${PREFIX}-exact`, 0);
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  it('una clínica nace con 3 días', async () => {
    const tenant = await raw.tenant.findUniqueOrThrow({
      where: { id: defaults.tenantId },
      select: { manualRateMaxAgeDays: true },
    });
    expect(tenant.manualRateMaxAgeDays).toBe(3);
  });

  it('la misma tasa del viernes: el sábado y el lunes la usa la de 3 días, la de 0 queda sin tasa', async () => {
    for (const day of [SATURDAY, MONDAY]) {
      await expect(quote(defaults, day)).resolves.toMatchObject({
        date: day,
        rateDate: FRIDAY,
        source: 'MANUAL',
        fromPerBase: 36.5,
      });
    }
    await expect(quote(exact, FRIDAY)).resolves.toMatchObject({
      rateDate: FRIDAY,
    });
    await expect(quote(exact, SATURDAY)).rejects.toBeInstanceOf(
      MissingExchangeRateError,
    );
  });

  it('pasados 3 días la de 3 días también queda sin tasa', async () => {
    await expect(quote(defaults, TUESDAY)).rejects.toBeInstanceOf(
      MissingExchangeRateError,
    );
  });

  it('RLS: la lectura por rango de una clínica no ve las tasas de la otra', async () => {
    await tenantContext.run(exact.tenantId, async () => {
      await manualRepo.ratesBetween('2026-10-01', '2026-11-30');
    });
    // Una tasa solo de `exact` el sábado: la clínica de 3 días no la ve.
    const membership = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId: exact.tenantId },
    });
    await raw.manualExchangeRate.create({
      data: {
        tenantId: exact.tenantId,
        date: new Date(`${SATURDAY}T00:00:00Z`),
        currency: 'EUR',
        rate: new Prisma.Decimal('0.9'),
        createdById: exact.userId,
        createdByMembershipId: membership.id,
      },
    });
    const seenByDefaults = await tenantContext.run(defaults.tenantId, () =>
      manualRepo.ratesBetween('2026-10-01', '2026-11-30'),
    );
    expect(seenByDefaults).toEqual([
      { date: FRIDAY, currency: 'VES', rate: 36.5 },
    ]);
    const seenByExact = await tenantContext.run(exact.tenantId, () =>
      manualRepo.ratesBetween('2026-10-01', '2026-11-30', ['EUR']),
    );
    expect(seenByExact).toEqual([
      { date: SATURDAY, currency: 'EUR', rate: 0.9 },
    ]);
  });

  it('«manual desde» es el suelo: una tasa anterior (DX-402) no la usa otro día', async () => {
    const clinic = await seedClinic(`${PREFIX}-floor`, 3);
    // Desde el sábado; la tasa del viernes (anterior) existe pero no cuenta.
    await raw.tenant.update({
      where: { id: clinic.tenantId },
      data: { manualExchangeRatesSince: new Date(`${SATURDAY}T00:00:00Z`) },
    });
    await expect(quote(clinic, SATURDAY)).rejects.toBeInstanceOf(
      MissingExchangeRateError,
    );
    await expect(quote(clinic, MONDAY)).rejects.toBeInstanceOf(
      MissingExchangeRateError,
    );
  });

  it('el CHECK solo admite de 0 a 30', async () => {
    for (const ok of [0, 30]) {
      await raw.tenant.update({
        where: { id: defaults.tenantId },
        data: { manualRateMaxAgeDays: ok },
      });
    }
    for (const bad of [-1, 31]) {
      await expect(
        raw.tenant.update({
          where: { id: defaults.tenantId },
          data: { manualRateMaxAgeDays: bad },
        }),
      ).rejects.toThrow(/tenants_manual_rate_max_age_days_check/);
    }
    await raw.tenant.update({
      where: { id: defaults.tenantId },
      data: { manualRateMaxAgeDays: 3 },
    });
  });

  it('cambiar el plazo escribe el evento con el antes y el después en la misma transacción; sin cambio, nada', async () => {
    const run = (days: number) =>
      tenantContext.run(defaults.tenantId, () =>
        settingsRepo.set(
          (before) => ({ ...before, manualRateMaxAgeDays: days }),
          ctxOf(defaults),
        ),
      );
    await expect(run(7)).resolves.toMatchObject({
      before: { manualRateMaxAgeDays: 3 },
      after: { manualRateMaxAgeDays: 7 },
    });
    await run(7);
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: defaults.tenantId,
        resourceType: 'CLINIC_SETTINGS',
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      reason: 'EXCHANGE_RATE_MAX_AGE',
      changedFields: ['manualRateMaxAgeDays'],
      configChange: {
        before: { manualRateMaxAgeDays: 3 },
        after: { manualRateMaxAgeDays: 7 },
      },
    });
    // Un valor fuera de rango rompe el CHECK y no deja evento a medias.
    await expect(run(99)).rejects.toThrow();
    await expect(
      raw.auditEvent.count({
        where: { tenantId: defaults.tenantId, resourceType: 'CLINIC_SETTINGS' },
      }),
    ).resolves.toBe(1);
  });
});
