import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { GetRatesForDateUseCase } from '../src/modules/exchange/application/use-cases/get-rates-for-date.use-case';
import {
  DEFAULT_PROVIDER_RATES_LIMITS,
  ProviderRatesGate,
} from '../src/modules/exchange/application/provider-rates-gate';
import {
  ExchangePrefetchJobs,
  PREFETCH_RATES_JOB,
} from '../src/modules/exchange/application/jobs/exchange-prefetch.jobs';
import { JobRegistry } from '../src/modules/jobs/application/job-registry';
import type { JobContext } from '../src/modules/jobs/domain/job';
import {
  ExchangeRateBudgetExceededError,
  type ExchangeRateProvider,
} from '../src/modules/exchange/domain/ports/exchange-rate-provider.port';
import { PrismaExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-exchange-rate.repository';
import { PrismaClinicExchangeSettingsRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-clinic-exchange-settings.repository';
import { PrismaManualExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-manual-exchange-rate.repository';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// SEC-054 contra Postgres: la ventana de días que una clínica puede pedir al
// proveedor sale de su alta y de su primer abono vivo (rol de la app, RLS), y
// la precarga diaria sigue llamando al proveedor y guardando el snapshot
// aunque las peticiones de las clínicas hayan agotado el presupuesto global.
// `raw` (DIRECT_URL, superusuario) siembra, observa y limpia. El proveedor es
// un doble que cuenta las llamadas: nunca sale a la red.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const settingsRepo = new PrismaClinicExchangeSettingsRepository(
  prisma,
  tenantContext,
);

// Días que ninguna otra suite siembra.
const USER_DAYS = ['2001-03-01', '2001-03-02', '2001-03-03'];
const PREFETCH_DAY = '2001-03-10';
const ALL_DAYS = [...USER_DAYS, PREFETCH_DAY];
const NOW = new Date('2001-03-10T00:05:00.000Z');

const ctx: JobContext = {
  jobId: 'j',
  attempt: 1,
  maxAttempts: 5,
  tenantId: null,
  signal: new AbortController().signal,
};

interface Clinic {
  tenantId: string;
  locationId: string;
  patientId: string;
  planId: string;
}

/**
 * Siembra como `raw` con `app.current_tenant` fijado: vale también con un
 * owner sin superusuario (las tablas de clínica tienen RLS FORCE).
 */
function asOwner<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return raw.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  return asOwner(tenantId, async (tx) => {
    const location = await tx.location.create({
      data: locationData(REGIONAL_BOGOTA_FIXTURE, { tenantId, name: 'Sede' }),
    });
    const patient = await tx.patient.create({
      data: { tenantId, firstName: 'Ana', lastName: 'Carrera' },
    });
    const plan = await tx.treatmentPlan.create({
      data: {
        tenantId,
        patientId: patient.id,
        currency: 'USD',
        status: 'ACCEPTED',
      },
    });
    return {
      tenantId,
      locationId: location.id,
      patientId: patient.id,
      planId: plan.id,
    };
  });
}

function seedPayment(
  clinic: Clinic,
  paidAt: Date,
  deletedAt: Date | null = null,
) {
  return asOwner(clinic.tenantId, (tx) =>
    tx.payment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId: clinic.locationId,
        treatmentPlanId: clinic.planId,
        patientId: clinic.patientId,
        amount: 100,
        currency: 'USD',
        paidAt,
        deletedAt,
      },
    }),
  );
}

describe('Cuota del proveedor de tasas (SEC-054, int)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: ALL_DAYS } },
    });
    a = await seedClinic('sec054-int-a');
    b = await seedClinic('sec054-int-b');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: ALL_DAYS } },
    });
    await prisma.$disconnect();
    await raw.$disconnect();
    Logger.overrideLogger(true);
  });

  describe('ventana de la clínica (providerWindow)', () => {
    it('sin abonos: el alta de la clínica y las zonas de sus sedes', async () => {
      const tenant = await raw.tenant.findUniqueOrThrow({
        where: { id: b.tenantId },
      });
      await expect(
        tenantContext.run(b.tenantId, () => settingsRepo.providerWindow()),
      ).resolves.toEqual({
        since: tenant.createdAt,
        timeZones: [REGIONAL_BOGOTA_FIXTURE.timeZone],
      });
    });

    it('un abono vivo anterior al alta la adelanta; uno anulado no', async () => {
      const first = new Date('2025-03-01T15:00:00.000Z');
      await seedPayment(a, first);
      await seedPayment(
        a,
        new Date('2024-01-01T15:00:00.000Z'),
        new Date('2025-01-01T00:00:00.000Z'),
      );
      const window = await tenantContext.run(a.tenantId, () =>
        settingsRepo.providerWindow(),
      );
      expect(window.since).toEqual(first);
      // Lo de otra clínica no cuenta.
      const other = await tenantContext.run(b.tenantId, () =>
        settingsRepo.providerWindow(),
      );
      expect(other.since.getTime()).toBeGreaterThan(first.getTime());
    });
  });

  it('la precarga diaria sigue llamando con el presupuesto global agotado por las clínicas', async () => {
    const fetchRates = jest.fn<
      ReturnType<ExchangeRateProvider['fetchRates']>,
      Parameters<ExchangeRateProvider['fetchRates']>
    >((date) =>
      Promise.resolve({
        base: 'USD',
        rates: { COP: 4000 + Number(date.slice(-2)) },
      }),
    );
    const clock = () => NOW;
    const gate = new ProviderRatesGate(
      {
        ...DEFAULT_PROVIDER_RATES_LIMITS,
        // 2 para las peticiones y 1 reservada para el barrido (SEC-058).
        global: { limit: 3, windowMs: 24 * 60 * 60_000 },
        sweep: { reserve: 1, clinicLimit: 1 },
      },
      clock,
    );
    const rates = new GetRatesForDateUseCase(
      new PrismaExchangeRateRepository(prisma),
      { fetchRates },
      settingsRepo,
      new PrismaManualExchangeRateRepository(prisma, tenantContext),
      tenantContext,
      gate,
      clock,
    );

    // Las peticiones de dos clínicas agotan su parte del global (2).
    await tenantContext.run(a.tenantId, () => rates.execute(USER_DAYS[0]));
    await tenantContext.run(b.tenantId, () => rates.execute(USER_DAYS[1]));
    const blocked = await tenantContext
      .run(a.tenantId, () => rates.execute(USER_DAYS[2]))
      .catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(ExchangeRateBudgetExceededError);
    expect((blocked as ExchangeRateBudgetExceededError).scope).toBe('GLOBAL');
    expect(fetchRates).toHaveBeenCalledTimes(2);

    // La precarga (sin clínica en el contexto) llama y guarda el snapshot.
    const registry = new JobRegistry();
    new ExchangePrefetchJobs(
      registry,
      rates,
      { get: () => 'solo-test-app-id' } as never,
      clock,
    ).onModuleInit();
    await registry.get(PREFETCH_RATES_JOB)!.handle({}, ctx);

    expect(fetchRates).toHaveBeenCalledTimes(3);
    expect(fetchRates).toHaveBeenLastCalledWith(PREFETCH_DAY);
    const stored = await raw.exchangeRateSnapshot.findMany({
      where: { date: PREFETCH_DAY },
    });
    expect(stored.map((s) => [s.currency, Number(s.rate)])).toEqual([
      ['COP', 4010],
    ]);

    // El día precargado lo leen las clínicas de la caché, sin presupuesto;
    // el global sigue agotado para lo demás.
    await expect(
      tenantContext.run(b.tenantId, () => rates.execute(PREFETCH_DAY)),
    ).resolves.toMatchObject({ rates: { COP: 4010 } });
    await expect(
      tenantContext.run(b.tenantId, () => rates.execute(USER_DAYS[2])),
    ).rejects.toBeInstanceOf(ExchangeRateBudgetExceededError);
    expect(fetchRates).toHaveBeenCalledTimes(3);
  });
});
