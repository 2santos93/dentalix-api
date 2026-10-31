import { Logger } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import { PrismaPlanAllocationRepository } from '../src/modules/payments/infrastructure/allocations/prisma-plan-allocation.repository';
import { PrismaPaymentBaseRetryRepository } from '../src/modules/payments/infrastructure/allocations/prisma-payment-base-retry.repository';
import { PlanAllocationRebalancer } from '../src/modules/payments/application/plan-allocation-rebalancer';
import { PaymentBaseRetries } from '../src/modules/payments/application/payment-base-retries';
import { PaymentRateBackupAudit } from '../src/modules/payments/application/payment-rate-backup-audit';
import { RecordAuditEventUseCase } from '../src/modules/audit/application/record-audit-event.use-case';
import { PrismaAuditEventRepository } from '../src/modules/audit/infrastructure/prisma-audit-event.repository';
import { PaymentAllocationJobs } from '../src/modules/payments/application/payment-allocation-jobs';
import { GetRatesForDateUseCase } from '../src/modules/exchange/application/use-cases/get-rates-for-date.use-case';
import { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import { ExchangeSourceChangeHooks } from '../src/modules/exchange/application/exchange-source-change-hooks';
import { ProviderRatesCallerScope } from '../src/modules/exchange/application/provider-rates-caller-scope';
import { PrismaExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-exchange-rate.repository';
import { PrismaClinicExchangeSettingsRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-clinic-exchange-settings.repository';
import { PrismaManualExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-manual-exchange-rate.repository';
import {
  ExchangeRateUnavailableError,
  type ExchangeRatesResult,
} from '../src/modules/exchange/domain/ports/exchange-rate-provider.port';
import { JobRegistry } from '../src/modules/jobs/application/job-registry';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenants } from './support/tenant-purge';

// DX-380 (OPS-045, DB-056), contra Postgres: la lista de reintentos
// `payment_base_retries` (alta por el trigger diferido, RLS FORCE entre dos
// clínicas), la cabeza de cola con 60 abonos atascados, las clínicas que el
// barrido visita (solo las que tienen pendientes) y la fuente MANUAL sin
// llamadas al proveedor. El proveedor es un doble que cuenta sus llamadas.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const paymentRepo = new PrismaPaymentRepository(prisma, tenantContext);
const allocationRepo = new PrismaPlanAllocationRepository(
  prisma,
  tenantContext,
);
const manualRepo = new PrismaManualExchangeRateRepository(
  prisma,
  tenantContext,
);
const retryRepo = new PrismaPaymentBaseRetryRepository(prisma, tenantContext);

/** El proveedor: COP por 1 USD; sin VES. `down` lo tumba. */
const provider = {
  calls: [] as string[],
  down: false,
  fetchRates(date: string): Promise<ExchangeRatesResult> {
    this.calls.push(date);
    if (this.down) {
      return Promise.reject(
        new ExchangeRateUnavailableError('Open Exchange Rates returned 503'),
      );
    }
    return Promise.resolve({ base: 'USD', rates: { COP: 4000 } });
  },
};
const convert = new ConvertAmountUseCase(
  new GetRatesForDateUseCase(
    new PrismaExchangeRateRepository(prisma),
    provider,
    new PrismaClinicExchangeSettingsRepository(prisma, tenantContext),
    manualRepo,
    tenantContext,
  ),
);
const retries = new PaymentBaseRetries(
  retryRepo,
  allocationRepo,
  convert,
  new PaymentRateBackupAudit(
    new RecordAuditEventUseCase(new PrismaAuditEventRepository(prisma)),
    tenantContext,
  ),
);
const jobs = new PaymentAllocationJobs(
  new JobRegistry(),
  new PlanAllocationRebalancer(allocationRepo, convert),
  retries,
  tenantContext,
  new ExchangeSourceChangeHooks(),
  new ProviderRatesCallerScope(),
);

const PREFIX = 'dx380-int';
/** Días sin snapshot propio (la suite los borra al empezar y al acabar). */
const DAYS = ['2001-02-03', '2001-02-04', '2001-02-05', '2001-02-06'];

interface Clinic {
  tenantId: string;
  userId: string;
  patientId: string;
  planId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, { tenantId, name: 'Sede' }),
  });
  const user = await raw.user.create({
    data: {
      email: `${subdomain}@example.com`,
      fullName: 'Admin',
      passwordHash: 'x',
    },
  });
  await raw.clinicMembership.create({
    data: { tenantId, userId: user.id, role: ClinicRole.ADMIN },
  });
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: 'Carrera' },
  });
  const plan = await raw.treatmentPlan.create({
    data: {
      tenantId,
      patientId: patient.id,
      currency: 'USD',
      status: 'ACCEPTED',
    },
  });
  return { tenantId, userId: user.id, patientId: patient.id, planId: plan.id };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { startsWith: PREFIX } },
    select: { id: true },
  });
  // DX-396: las tablas de clínica salen del catálogo (también
  // payment_base_retries y las que vengan), no de una lista a mano.
  await purgeTenants(
    raw,
    tenants.map((t) => t.id),
  );
  await raw.user.deleteMany({
    where: { email: { startsWith: PREFIX } },
  });
  await raw.exchangeRateSnapshot.deleteMany({ where: { date: { in: DAYS } } });
}

const inClinic = <T>(clinic: Clinic, fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(clinic.tenantId, fn);

/** Un abono «sin tasa» (sin base) como lo deja el alta sin tasa del día. */
function pay(clinic: Clinic, currency: string, day: string): Promise<string> {
  return inClinic(clinic, async () => {
    const payment = await paymentRepo.create({
      treatmentPlanId: clinic.planId,
      patientId: clinic.patientId,
      amount: 4000,
      currency,
      paidAt: { civilDate: day },
      createdById: clinic.userId,
      receiptPlanBalance: null,
      planAmount: null,
      frozenRate: null,
    });
    return payment.id;
  });
}

const retryOf = (paymentId: string) =>
  raw.paymentBaseRetry.findFirst({ where: { paymentId } });

describe('DX-380 · reintentos de abonos sin base (int)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    await cleanup();
    a = await seedClinic(`${PREFIX}-a`);
    b = await seedClinic(`${PREFIX}-b`);
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await appRole.$disconnect();
    await prisma.$disconnect();
    Logger.overrideLogger(true);
  });

  beforeEach(() => {
    provider.calls = [];
    provider.down = false;
  });

  it('el alta de un abono sin tasa crea su reintento al confirmar; uno con base, no', async () => {
    const pending = await pay(a, 'VES', DAYS[0]);
    expect(await retryOf(pending)).toMatchObject({
      tenantId: a.tenantId,
      attempts: 0,
      lastReason: null,
    });

    const settled = await inClinic(a, async () => {
      const payment = await paymentRepo.create({
        treatmentPlanId: a.planId,
        patientId: a.patientId,
        amount: 10,
        currency: 'USD',
        paidAt: { civilDate: DAYS[0] },
        createdById: a.userId,
        receiptPlanBalance: null,
        planAmount: { amount: 10, planCurrency: 'USD', rateDate: DAYS[0] },
        frozenRate: null,
      });
      return payment.id;
    });
    expect(await retryOf(settled)).toBeNull();
  });

  it('RLS FORCE: una clínica no ve ni escribe los reintentos de otra, y la FK es por clínica', async () => {
    const paymentA = await pay(a, 'VES', DAYS[0]);
    const asTenant = <T>(
      tenantId: string,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ) =>
      appRole.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        return fn(tx);
      });

    expect(
      await asTenant(a.tenantId, (tx) =>
        tx.paymentBaseRetry.count({ where: { paymentId: paymentA } }),
      ),
    ).toBe(1);
    expect(
      await asTenant(b.tenantId, (tx) =>
        tx.paymentBaseRetry.count({ where: { paymentId: paymentA } }),
      ),
    ).toBe(0);
    expect(
      await asTenant(b.tenantId, (tx) =>
        tx.paymentBaseRetry.updateMany({
          where: { paymentId: paymentA },
          data: { nextAttemptAt: new Date('2000-01-01T00:00:00Z') },
        }),
      ),
    ).toEqual({ count: 0 });
    // Sin tenant, nada.
    expect(
      await appRole.paymentBaseRetry.count({ where: { paymentId: paymentA } }),
    ).toBe(0);
    // Con el tenant de B, la fila de A no pasa el WITH CHECK.
    await expect(
      asTenant(
        b.tenantId,
        (tx) =>
          tx.$executeRaw`INSERT INTO "payment_base_retries" ("tenantId", "paymentId")
                       VALUES (${a.tenantId}::uuid, ${paymentA}::uuid)`,
      ),
    ).rejects.toThrow(/row-level security/);
    // B no puede apuntar al abono de A con su clínica (FK compuesta).
    await expect(
      asTenant(
        b.tenantId,
        (tx) =>
          tx.$executeRaw`INSERT INTO "payment_base_retries" ("tenantId", "paymentId")
                       VALUES (${b.tenantId}::uuid, ${paymentA}::uuid)`,
      ),
    ).rejects.toThrow(/payment_base_retries_payment_fkey/);
  });

  it('con 60 abonos atascados más nuevos, el resoluble más antiguo recibe su base en la primera pasada', async () => {
    const clinic = await seedClinic(`${PREFIX}-queue`);
    const resolvable = await pay(clinic, 'COP', DAYS[1]);
    const stuck: string[] = [];
    for (let i = 0; i < 60; i += 1)
      stuck.push(await pay(clinic, 'VES', DAYS[1]));

    const first = await inClinic(clinic, () => retries.retryDue(50));

    expect(first).toEqual({ resolved: 1, withoutRate: 49, failed: 0 });
    const base = await raw.paymentPlanAmount.findUniqueOrThrow({
      where: { paymentId: resolvable },
    });
    expect(Number(base.amount)).toBe(1);
    expect(await retryOf(resolvable)).toBeNull();
    // Un día, una llamada: el snapshot queda guardado para el resto.
    expect(provider.calls).toEqual([DAYS[1]]);
    // Los 49 intentados esperan 1 min; los 11 que no entraron van primero.
    const [{ now }] = await raw.$queryRaw<{ now: Date }[]>`
      SELECT timezone('UTC', now()) AS "now"`;
    const tried = await raw.paymentBaseRetry.findMany({
      where: { tenantId: clinic.tenantId, attempts: 1 },
    });
    expect(tried).toHaveLength(49);
    for (const row of tried) {
      expect(row.lastReason).toBe('NO_RATE');
      const waitMs = row.nextAttemptAt.getTime() - now.getTime();
      expect(waitMs).toBeGreaterThan(50_000);
      expect(waitMs).toBeLessThanOrEqual(60_000);
    }
    const second = await inClinic(clinic, () => retries.retryDue(50));
    expect(second).toEqual({ resolved: 0, withoutRate: 11, failed: 0 });
    expect(await inClinic(clinic, () => retries.retryDue(50))).toEqual({
      resolved: 0,
      withoutRate: 0,
      failed: 0,
    });
    expect(stuck).toHaveLength(60);
  });

  it('con el proveedor caído, el fallo cuenta como «sin tasa» y el día no se vuelve a pedir (caché negativa)', async () => {
    const clinic = await seedClinic(`${PREFIX}-down`);
    provider.down = true;
    const id = await pay(clinic, 'COP', DAYS[2]);
    const other = await pay(clinic, 'COP', DAYS[2]);

    expect(await inClinic(clinic, () => retries.retryDue(50))).toEqual({
      resolved: 0,
      withoutRate: 2,
      failed: 0,
    });
    expect(provider.calls).toEqual([DAYS[2]]);
    // Adelantados a ya (como tras registrar una tasa): la caché negativa del
    // día evita la segunda llamada.
    await inClinic(clinic, () => retries.wake());
    await inClinic(clinic, () => retries.retryDue(50));
    expect(provider.calls).toEqual([DAYS[2]]);
    expect(await retryOf(id)).toMatchObject({
      attempts: 2,
      lastReason: 'NO_RATE',
    });
    expect(await retryOf(other)).toMatchObject({ attempts: 2 });
  });

  it('una clínica en MANUAL sin la tasa del día no llama nunca al proveedor; al registrarla se resuelve', async () => {
    const clinic = await seedClinic(`${PREFIX}-manual`);
    await raw.tenant.update({
      where: { id: clinic.tenantId },
      data: {
        exchangeRateSource: 'MANUAL',
        manualExchangeRatesSince: new Date(`${DAYS[3]}T00:00:00Z`),
      },
    });
    const id = await pay(clinic, 'COP', DAYS[3]);

    expect(await inClinic(clinic, () => retries.retryDue(50))).toEqual({
      resolved: 0,
      withoutRate: 1,
      failed: 0,
    });
    expect(provider.calls).toEqual([]);

    await inClinic(clinic, () =>
      manualRepo.create({
        date: DAYS[3],
        currency: 'COP',
        rate: 4000,
        createdById: clinic.userId,
      }),
    );
    await inClinic(clinic, () => retries.wake());
    expect(await inClinic(clinic, () => retries.retryDue(50))).toEqual({
      resolved: 1,
      withoutRate: 0,
      failed: 0,
    });
    expect(provider.calls).toEqual([]);
    expect(await retryOf(id)).toBeNull();
  });

  it('el barrido solo abre transacción en las clínicas con pendientes (100 clínicas, 1 pendiente)', async () => {
    const many = await raw.tenant.createManyAndReturn({
      data: Array.from({ length: 100 }, (_, i) => ({
        name: `${PREFIX}-many-${i}`,
        subdomain: `${PREFIX}-many-${i}`,
      })),
      select: { id: true },
    });
    const pending = await seedClinic(`${PREFIX}-pending`);
    const id = await pay(pending, 'COP', DAYS[1]);
    const mine = new Set([...many.map((t) => t.id), pending.tenantId]);
    // La consulta real, acotada a las clínicas de esta prueba (BD compartida).
    const due = await retryRepo.dueTenantIds();
    expect(due.filter((t) => mine.has(t))).toEqual([pending.tenantId]);
    jest
      .spyOn(retryRepo, 'dueTenantIds')
      .mockResolvedValue(due.filter((t) => mine.has(t)));
    const opened: string[] = [];
    const runWithTenant = prisma.runWithTenant.bind(prisma);
    jest
      .spyOn(prisma, 'runWithTenant')
      .mockImplementation((...args: Parameters<typeof runWithTenant>) => {
        opened.push(
          typeof args[0] === 'string'
            ? args[0]
            : (tenantContext.getTenantId() ?? ''),
        );
        return runWithTenant(...args);
      });

    await jobs.sweep();

    jest.restoreAllMocks();
    expect(new Set(opened)).toEqual(new Set([pending.tenantId]));
    expect(await retryOf(id)).toBeNull();
  });

  it('la consulta de clínicas incluye las que solo tienen planes por repartir y deja el tenant de la sesión como estaba', async () => {
    const clinic = await seedClinic(`${PREFIX}-drain`);
    await raw.planAllocationRebalanceRequest.create({
      data: { tenantId: clinic.tenantId, treatmentPlanId: clinic.planId },
    });
    const [listed, after] = await prisma.runWithTenant(
      a.tenantId,
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT t AS "id" FROM dx_payment_allocation_sweep_tenants() AS t`;
        const [{ tenant }] = await tx.$queryRaw<{ tenant: string }[]>`
        SELECT current_setting('app.current_tenant', true) AS "tenant"`;
        return [rows.map((r) => r.id), tenant] as const;
      },
    );
    expect(listed).toContain(clinic.tenantId);
    expect(after).toBe(a.tenantId);
  });

  it('el aviso cuenta los abonos vivos sin base de más de 24 h y desaparece al anularlos', async () => {
    const clinic = await seedClinic(`${PREFIX}-backlog`);
    const old = await pay(clinic, 'VES', DAYS[0]);
    await pay(clinic, 'VES', DAYS[0]);
    const since = new Date(Date.now() - 30 * 3_600_000);
    since.setUTCMilliseconds(0);
    await raw.paymentBaseRetry.updateMany({
      where: { paymentId: old },
      data: { createdAt: since },
    });

    expect(await inClinic(clinic, () => retries.backlog())).toEqual({
      count: 1,
      oldestSince: since,
    });
    expect(await inClinic(b, () => retries.backlog())).toEqual({
      count: 0,
      oldestSince: null,
    });

    await raw.payment.update({
      where: { id: old },
      data: { deletedAt: new Date(), voidedAt: new Date() },
    });
    expect(await inClinic(clinic, () => retries.backlog())).toEqual({
      count: 0,
      oldestSince: null,
    });
  });
});
