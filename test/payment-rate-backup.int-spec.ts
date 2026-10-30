import { Logger } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import { PrismaPlanAllocationRepository } from '../src/modules/payments/infrastructure/allocations/prisma-plan-allocation.repository';
import { PrismaPaymentBaseRetryRepository } from '../src/modules/payments/infrastructure/allocations/prisma-payment-base-retry.repository';
import { PaymentBaseRetries } from '../src/modules/payments/application/payment-base-retries';
import { PaymentRateBackupAudit } from '../src/modules/payments/application/payment-rate-backup-audit';
import { GetRatesForDateUseCase } from '../src/modules/exchange/application/use-cases/get-rates-for-date.use-case';
import { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import { PrismaExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-exchange-rate.repository';
import { PrismaClinicExchangeSettingsRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-clinic-exchange-settings.repository';
import { PrismaManualExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-manual-exchange-rate.repository';
import { ManualExchangeRateInUseError } from '../src/modules/exchange/domain/ports/manual-exchange-rate-repository.port';
import {
  ExchangeRateUnavailableError,
  type ExchangeRatesResult,
} from '../src/modules/exchange/domain/ports/exchange-rate-provider.port';
import { RecordAuditEventUseCase } from '../src/modules/audit/application/record-audit-event.use-case';
import { PrismaAuditEventRepository } from '../src/modules/audit/infrastructure/prisma-audit-event.repository';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenants } from './support/tenant-purge';

// DX-402, contra Postgres: la tasa manual de un día anterior a «manual desde»
// es la tasa de respaldo de los abonos pendientes de ese día sin tasa del
// proveedor. El barrido (reintento de DX-380) la congela con RLS FORCE, deja
// el evento sin usuario que admite audit_events_actor_check, y la tasa ya
// congelada no cambia (trigger manual_exchange_rates_in_use_guard, DX-375).
// El proveedor es un doble caído que cuenta sus llamadas.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
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

const provider = {
  calls: [] as string[],
  fetchRates(date: string): Promise<ExchangeRatesResult> {
    this.calls.push(date);
    return Promise.reject(
      new ExchangeRateUnavailableError('Open Exchange Rates returned 503'),
    );
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

const PREFIX = 'dx402-int';
/** Días sin snapshot propio (la suite los borra al empezar y al acabar). */
const DAY = '2001-03-05';
const SNAPSHOT_DAY = '2001-03-06';
const SINCE = '2001-03-08';

interface Clinic {
  tenantId: string;
  userId: string;
  patientId: string;
  planId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: {
      name: subdomain,
      subdomain,
      exchangeRateSource: 'MANUAL',
      manualExchangeRatesSince: new Date(`${SINCE}T00:00:00Z`),
    },
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
      currency: 'COP',
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
  await purgeTenants(
    raw,
    tenants.map((t) => t.id),
  );
  await raw.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await raw.exchangeRateSnapshot.deleteMany({
    where: { date: { in: [DAY, SNAPSHOT_DAY] } },
  });
}

const inClinic = <T>(clinic: Clinic, fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(clinic.tenantId, fn);

/** Un abono en USD «sin tasa» al plan en COP, como lo deja el alta. */
function pay(clinic: Clinic, day: string): Promise<string> {
  return inClinic(clinic, async () => {
    const payment = await paymentRepo.create({
      treatmentPlanId: clinic.planId,
      patientId: clinic.patientId,
      amount: 50,
      currency: 'USD',
      paidAt: { civilDate: day },
      createdById: clinic.userId,
      receiptPlanBalance: null,
      planAmount: null,
      frozenRate: null,
    });
    return payment.id;
  });
}

function registerRate(
  clinic: Clinic,
  date: string,
  rate: number,
): Promise<string> {
  return inClinic(clinic, async () => {
    const saved = await manualRepo.create({
      date,
      currency: 'COP',
      rate,
      createdById: clinic.userId,
    });
    return saved.id;
  });
}

const frozenOf = (id: string) =>
  raw.payment.findUniqueOrThrow({
    where: { id },
    select: {
      exchangeRateSource: true,
      exchangeRateDate: true,
      exchangeRateTo: true,
    },
  });

describe('DX-402 · tasa de respaldo de un día anterior a manual (int)', () => {
  beforeAll(async () => {
    Logger.overrideLogger(false);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.$disconnect();
    Logger.overrideLogger(true);
  });

  beforeEach(() => {
    provider.calls = [];
  });

  it('el barrido congela la manual del día como respaldo, crea la base, cierra el reintento y lo audita sin usuario', async () => {
    const clinic = await seedClinic(`${PREFIX}-qa`);
    const id = await pay(clinic, DAY);
    expect(await inClinic(clinic, () => retries.retryDue(50))).toEqual({
      resolved: 0,
      withoutRate: 1,
      failed: 0,
    });

    await registerRate(clinic, DAY, 4000);
    expect(
      await inClinic(clinic, () => retries.pendingOnDay(DAY, 'COP')),
    ).toEqual({ count: 1, providerRateSaved: false });
    await inClinic(clinic, () => retries.wake());
    expect(await inClinic(clinic, () => retries.retryDue(50))).toEqual({
      resolved: 1,
      withoutRate: 0,
      failed: 0,
    });

    expect(await frozenOf(id)).toEqual({
      exchangeRateSource: 'MANUAL',
      exchangeRateDate: new Date(`${DAY}T00:00:00Z`),
      exchangeRateTo: new Prisma.Decimal(4000),
    });
    expect(
      await raw.paymentPlanAmount.findUnique({ where: { paymentId: id } }),
    ).toMatchObject({ amount: new Prisma.Decimal(200000), currency: 'COP' });
    expect(
      await raw.paymentBaseRetry.findFirst({ where: { paymentId: id } }),
    ).toBeNull();
    expect(
      await inClinic(clinic, () => retries.pendingOnDay(DAY, 'COP')),
    ).toEqual({ count: 0, providerRateSaved: false });

    const events = await raw.auditEvent.findMany({
      where: { tenantId: clinic.tenantId, resourceId: id },
    });
    expect(events).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'PAYMENT',
        actorUserId: null,
        actorRole: null,
        patientId: clinic.patientId,
        metadata: {
          reason: 'EXCHANGE_RATE_BACKUP',
          origin: 'JOB',
          exchangeRateBackup: {
            rateDate: DAY,
            manualSince: SINCE,
            currencies: ['COP', 'USD'],
          },
        },
      }),
    ]);
    // Con manual y la tasa del día registrada, no se pidió nada al proveedor.
    expect(provider.calls).toEqual([DAY]);
  });

  it('la tasa congelada no cambia: la manual usada no se corrige (DX-375) y otro barrido no la toca', async () => {
    const clinic = await seedClinic(`${PREFIX}-frozen`);
    const id = await pay(clinic, DAY);
    const rateId = await registerRate(clinic, DAY, 4000);
    await inClinic(clinic, () => retries.retryDue(50));
    expect((await frozenOf(id)).exchangeRateTo).toEqual(
      new Prisma.Decimal(4000),
    );

    await expect(
      inClinic(clinic, () => manualRepo.correct(rateId, 4100)),
    ).rejects.toBeInstanceOf(ManualExchangeRateInUseError);
    await expect(
      raw.$executeRaw`UPDATE "manual_exchange_rates" SET "rate" = 4100 WHERE "id" = ${rateId}::uuid`,
    ).rejects.toThrow();
    await inClinic(clinic, () => retries.retryDue(50));
    expect((await frozenOf(id)).exchangeRateTo).toEqual(
      new Prisma.Decimal(4000),
    );
  });

  it('un día con tasa del proveedor guardada no usa la manual: se congela la automática', async () => {
    const clinic = await seedClinic(`${PREFIX}-snapshot`);
    await raw.exchangeRateSnapshot.create({
      data: { date: SNAPSHOT_DAY, currency: 'COP', rate: 3900 },
    });
    const id = await pay(clinic, SNAPSHOT_DAY);
    await registerRate(clinic, SNAPSHOT_DAY, 4000);
    expect(
      await inClinic(clinic, () => retries.pendingOnDay(SNAPSHOT_DAY, 'COP')),
    ).toEqual({ count: 1, providerRateSaved: true });

    await inClinic(clinic, () => retries.retryDue(50));
    expect(await frozenOf(id)).toEqual({
      exchangeRateSource: 'AUTOMATIC',
      exchangeRateDate: new Date(`${SNAPSHOT_DAY}T00:00:00Z`),
      exchangeRateTo: new Prisma.Decimal(3900),
    });
    expect(
      await raw.auditEvent.count({
        where: { tenantId: clinic.tenantId, resourceId: id },
      }),
    ).toBe(0);
  });

  it('la manual de otra clínica no sirve de respaldo (RLS) y el recuento es solo de la clínica del contexto', async () => {
    const mine = await seedClinic(`${PREFIX}-mine`);
    const other = await seedClinic(`${PREFIX}-other`);
    const id = await pay(mine, DAY);
    await registerRate(other, DAY, 4000);

    expect(await inClinic(mine, () => retries.retryDue(50))).toEqual({
      resolved: 0,
      withoutRate: 1,
      failed: 0,
    });
    expect((await frozenOf(id)).exchangeRateSource).toBeNull();
    expect(
      await inClinic(other, () => retries.pendingOnDay(DAY, 'COP')),
    ).toEqual({ count: 0, providerRateSaved: false });
    expect(
      await inClinic(mine, () => retries.pendingOnDay(DAY, 'EUR')),
    ).toEqual({ count: 0, providerRateSaved: false });
    expect(
      await inClinic(mine, () => retries.pendingOnDay(DAY, 'COP')),
    ).toEqual({ count: 1, providerRateSaved: false });
  });

  it('el CHECK de actor sigue rechazando otros eventos de abono sin usuario', async () => {
    const clinic = await seedClinic(`${PREFIX}-check`);
    await expect(
      prisma.runWithTenant(
        clinic.tenantId,
        (tx) =>
          tx.$executeRaw`INSERT INTO "audit_events" ("id","tenantId","action","resourceType","resourceId","metadata")
            VALUES (gen_random_uuid(), ${clinic.tenantId}::uuid, 'UPDATE', 'PAYMENT', gen_random_uuid(),
                    '{"reason":"EXCHANGE_RATE_BACKUP"}'::jsonb)`,
      ),
    ).rejects.toThrow(/audit_events_actor_check/);
  });
});
