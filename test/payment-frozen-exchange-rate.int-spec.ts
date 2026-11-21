import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import { PrismaPlanAllocationRepository } from '../src/modules/payments/infrastructure/allocations/prisma-plan-allocation.repository';
import { PlanAllocationRebalancer } from '../src/modules/payments/application/plan-allocation-rebalancer';
import { freezePaymentRate } from '../src/modules/payments/application/payment-exchange-rate';
import type { FrozenExchangeRate } from '../src/modules/payments/domain/payment-exchange-rate';
import type { ReceiptPlanBalance } from '../src/modules/payments/domain/receipt-snapshot';
import { GetRatesForDateUseCase } from '../src/modules/exchange/application/use-cases/get-rates-for-date.use-case';
import { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import { PrismaExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-exchange-rate.repository';
import { PrismaClinicExchangeSettingsRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-clinic-exchange-settings.repository';
import { PrismaManualExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-manual-exchange-rate.repository';
import { ManualExchangeRateInUseError } from '../src/modules/exchange/domain/ports/manual-exchange-rate-repository.port';
import { PaymentBaseRetries } from '../src/modules/payments/application/payment-base-retries';
import { PaymentRateBackupAudit } from '../src/modules/payments/application/payment-rate-backup-audit';
import { RecordAuditEventUseCase } from '../src/modules/audit/application/record-audit-event.use-case';
import { PrismaAuditEventRepository } from '../src/modules/audit/infrastructure/prisma-audit-event.repository';
import { PrismaPaymentBaseRetryRepository } from '../src/modules/payments/infrastructure/allocations/prisma-payment-base-retry.repository';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-375 contra Postgres con el rol de la app (runWithTenant, RLS FORCE): cada
// abono congela la tasa que usó y su fuente. Dos clínicas el MISMO día con
// fuentes distintas (A automática, B manual) congelan tasas distintas sin
// verse; una tasa manual usada no se cambia (la API y el trigger); un abono
// sin tasa queda «sin tasa» y el barrido la congela cuando la hay. `raw`
// (DIRECT_URL, superusuario) siembra, observa y limpia. El proveedor nunca se
// llama: hay snapshot del día.
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
const convert = new ConvertAmountUseCase(
  new GetRatesForDateUseCase(
    new PrismaExchangeRateRepository(prisma),
    {
      fetchRates: () =>
        Promise.reject(new Error('no debe llamar al proveedor')),
    },
    new PrismaClinicExchangeSettingsRepository(prisma, tenantContext),
    manualRepo,
    tenantContext,
  ),
);
const rebalancer = new PlanAllocationRebalancer(allocationRepo, convert);
const retries = new PaymentBaseRetries(
  new PrismaPaymentBaseRetryRepository(prisma, tenantContext),
  allocationRepo,
  convert,
  new PaymentRateBackupAudit(
    new RecordAuditEventUseCase(new PrismaAuditEventRepository(prisma)),
    tenantContext,
  ),
);

const SUBDOMAINS = ['dx375-int-auto', 'dx375-int-manual'];
const DAY = '2026-10-29';
const OTHER_DAY = '2026-10-28';
/** Snapshot del proveedor del día (el mismo para todas las clínicas). */
const PROVIDER = { VES: 4000, EUR: 0.9 };

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
    data: locationData(REGIONAL_CARACAS_FIXTURE, { tenantId, name: 'Sede' }),
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
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length > 0) {
    const where = { tenantId: { in: ids } };
    await raw.paymentAllocation.deleteMany({ where });
    await raw.paymentAllocationMovement.deleteMany({ where });
    await raw.paymentPlanAmount.deleteMany({ where });
    await raw.paymentReceipt.deleteMany({ where });
    await raw.payment.deleteMany({ where });
    await raw.treatmentPlan.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.manualExchangeRate.deleteMany({ where });
    await raw.clinicMembership.deleteMany({ where });
    await raw.paymentReceiptCounter.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  await raw.user.deleteMany({
    where: { email: { in: SUBDOMAINS.map((s) => `${s}@example.com`) } },
  });
  await raw.exchangeRateSnapshot.deleteMany({
    where: { date: { in: [DAY, OTHER_DAY] } },
  });
}

const inClinic = <T>(clinic: Clinic, fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(clinic.tenantId, fn);

/** El alta del abono como `RecordPaymentUseCase`: cotiza fuera y congela dentro. */
async function pay(
  clinic: Clinic,
  amount: number,
  day: string,
  frozenOverride?: FrozenExchangeRate | null,
  receiptPlanBalance: ReceiptPlanBalance | null = null,
): Promise<string> {
  return inClinic(clinic, async () => {
    const frozenRate =
      frozenOverride !== undefined
        ? frozenOverride
        : await freezePaymentRate(convert, {
            currency: 'VES',
            targetCurrency: 'USD',
            paidOn: day,
          });
    const payment = await paymentRepo.create({
      treatmentPlanId: clinic.planId,
      patientId: clinic.patientId,
      amount,
      currency: 'VES',
      paidAt: { civilDate: day },
      createdById: clinic.userId,
      receiptPlanBalance,
      planAmount: null,
      frozenRate,
    });
    return payment.id;
  });
}

function storedRate(paymentId: string) {
  return raw.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: {
      exchangeRateCurrency: true,
      exchangeRateFrom: true,
      exchangeRateTo: true,
      exchangeRateSource: true,
      exchangeRateDate: true,
    },
  });
}

const asNumbers = (row: Awaited<ReturnType<typeof storedRate>>) => ({
  currency: row.exchangeRateCurrency,
  from: row.exchangeRateFrom === null ? null : Number(row.exchangeRateFrom),
  to: row.exchangeRateTo === null ? null : Number(row.exchangeRateTo),
  source: row.exchangeRateSource,
  date: row.exchangeRateDate?.toISOString().slice(0, 10) ?? null,
});

async function registerManual(
  clinic: Clinic,
  date: string,
  currency: string,
  rate: number,
): Promise<string> {
  const saved = await inClinic(clinic, () =>
    manualRepo.create({
      date,
      currency,
      rate,
      effectiveFrom: new Date(`${date}T00:00:00Z`),
      createdById: clinic.userId,
    }),
  );
  return saved.id;
}

describe('Tasa congelada en cada abono (DX-375, int)', () => {
  let auto: Clinic;
  let manual: Clinic;

  beforeAll(async () => {
    await cleanup();
    await raw.exchangeRateSnapshot.createMany({
      data: [DAY, OTHER_DAY].flatMap((date) =>
        Object.entries(PROVIDER).map(([currency, rate]) => ({
          date,
          currency,
          rate,
        })),
      ),
    });
    auto = await seedClinic(SUBDOMAINS[0]);
    manual = await seedClinic(SUBDOMAINS[1]);
    await raw.tenant.update({
      where: { id: manual.tenantId },
      data: {
        exchangeRateSource: 'MANUAL',
        manualExchangeRatesSince: new Date(`${OTHER_DAY}T00:00:00.000Z`),
      },
    });
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await appRole.$disconnect();
    await prisma.$disconnect();
  });

  it('dos clínicas el mismo día con fuentes distintas congelan cada una su tasa y su fuente', async () => {
    await registerManual(manual, DAY, 'VES', 4100);
    const a = await pay(auto, 400000, DAY);
    const b = await pay(manual, 410000, DAY);

    expect(asNumbers(await storedRate(a))).toEqual({
      currency: 'USD',
      from: 4000,
      to: 1,
      source: 'AUTOMATIC',
      date: DAY,
    });
    expect(asNumbers(await storedRate(b))).toEqual({
      currency: 'USD',
      from: 4100,
      to: 1,
      source: 'MANUAL',
      date: DAY,
    });
    // RLS FORCE: ninguna ve el abono de la otra.
    const seenByAuto = await inClinic(auto, () =>
      paymentRepo.listByPlan(manual.planId),
    );
    expect(seenByAuto).toEqual([]);
    const [mine] = await inClinic(manual, () =>
      paymentRepo.listByPlan(manual.planId),
    );
    expect(mine).toMatchObject({
      exchangeRateStatus: 'FROZEN',
      frozenRate: { source: 'MANUAL', fromPerBase: 4100 },
    });
  });

  it('una tasa manual usada no se cambia: el repositorio lo rechaza y la BD también', async () => {
    const [rate] = await inClinic(manual, () => manualRepo.listRecent(10));
    expect(rate).toMatchObject({ date: DAY, currency: 'VES', inUse: true });
    await expect(
      inClinic(manual, () => manualRepo.correct(rate.id, 4200)),
    ).rejects.toBeInstanceOf(ManualExchangeRateInUseError);
    // Aunque la app salte la comprobación, el trigger lo impide.
    await expect(
      appRole.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${manual.tenantId}, true)`;
        return tx.$executeRaw`UPDATE "manual_exchange_rates" SET "rate" = 4200 WHERE "id" = ${rate.id}::uuid`;
      }),
    ).rejects.toThrow(/ya la usa un abono/);
    const row = await raw.manualExchangeRate.findUniqueOrThrow({
      where: { id: rate.id },
    });
    expect(Number(row.rate)).toBe(4100);
  });

  it('una tasa manual sin usar se corrige', async () => {
    const id = await registerManual(manual, DAY, 'EUR', 0.91);
    await expect(
      inClinic(manual, () => manualRepo.correct(id, 0.92)),
    ).resolves.toMatchObject({ rate: 0.92, inUse: false });
  });

  it('una tasa manual que cambió entre la cotización y el alta no se congela: queda «sin tasa»', async () => {
    const stale: FrozenExchangeRate = {
      currency: 'USD',
      fromPerBase: 4099,
      toPerBase: 1,
      source: 'MANUAL',
      date: DAY,
    };
    const id = await pay(manual, 1000, DAY, stale);
    expect(asNumbers(await storedRate(id))).toEqual({
      currency: 'USD',
      from: null,
      to: null,
      source: null,
      date: null,
    });
  });

  // Revisión DX-375: el saldo del recibo se calculó fuera con la tasa
  // cotizada; si dentro ya no vale, el abono no cuenta en el saldo y el
  // recibo no puede decir que sí (sale sin saldo, como cualquier «sin tasa»).
  it('si la tasa cotizada ya no vale dentro, el recibo sale sin saldo del plan', async () => {
    const stale: FrozenExchangeRate = {
      currency: 'USD',
      fromPerBase: 4099,
      toPerBase: 1,
      source: 'MANUAL',
      date: DAY,
    };
    const id = await pay(manual, 1000, DAY, stale, {
      currency: 'USD',
      billable: 100,
      paid: 0.24,
      balance: 99.76,
    });
    const receipt = await raw.paymentReceipt.findUniqueOrThrow({
      where: { paymentId: id },
      select: { snapshot: true },
    });
    expect(
      (receipt.snapshot as { planBalance: unknown }).planBalance,
    ).toBeNull();
  });

  it('con la tasa congelada el recibo conserva su saldo del plan', async () => {
    const id = await pay(auto, 4000, DAY, undefined, {
      currency: 'USD',
      billable: 100,
      paid: 1,
      balance: 99,
    });
    const receipt = await raw.paymentReceipt.findUniqueOrThrow({
      where: { paymentId: id },
      select: { snapshot: true },
    });
    expect(
      (receipt.snapshot as { planBalance: unknown }).planBalance,
    ).toMatchObject({ paid: 1, balance: 99 });
  });

  it('sin tasa del día el abono se guarda «sin tasa» y el barrido la congela al registrarla', async () => {
    const id = await pay(manual, 205000, OTHER_DAY);
    const [pending] = await inClinic(manual, () =>
      paymentRepo
        .listByPlan(manual.planId)
        .then((ps) => ps.filter((p) => p.id === id)),
    );
    expect(pending.exchangeRateStatus).toBe('MISSING');
    // Sin la tasa de ese día sigue «sin tasa» (y no se pide al proveedor).
    await inClinic(manual, () => retries.retryDue(50));
    expect((await storedRate(id)).exchangeRateFrom).toBeNull();

    // DX-380: registrar la tasa adelanta el reintento aplazado (el hook de
    // las tasas de la clínica llama a `wake`).
    await registerManual(manual, OTHER_DAY, 'VES', 4100);
    await inClinic(manual, () => retries.wake());
    await inClinic(manual, () => retries.retryDue(50));
    expect(asNumbers(await storedRate(id))).toMatchObject({
      from: 4100,
      source: 'MANUAL',
      date: OTHER_DAY,
    });
  });

  it('un abono anterior a DX-375 (columnas NULL) lo congela el barrido con la tasa de su día', async () => {
    const id = await pay(auto, 80000, OTHER_DAY);
    await raw.payment.update({
      where: { id },
      data: {
        exchangeRateCurrency: null,
        exchangeRateFrom: null,
        exchangeRateTo: null,
        exchangeRateSource: null,
        exchangeRateDate: null,
        // DX-586: también la referencia (el instante lo quita la BD).
        exchangeRateRef: null,
        exchangeRateValueDate: null,
      },
    });
    const [legacy] = await inClinic(auto, () =>
      paymentRepo
        .listByPlan(auto.planId)
        .then((ps) => ps.filter((p) => p.id === id)),
    );
    expect(legacy.exchangeRateStatus).toBe('LEGACY');
    await inClinic(auto, () => rebalancer.freezeAllPending());
    expect(asNumbers(await storedRate(id))).toEqual({
      currency: 'USD',
      from: 4000,
      to: 1,
      source: 'AUTOMATIC',
      date: OTHER_DAY,
    });
  });

  it('el CHECK exige las cuatro columnas de la tasa juntas y una moneda distinta', async () => {
    const id = await pay(auto, 1000, DAY);
    await expect(
      raw.$executeRaw`UPDATE "payments" SET "exchangeRateSource" = NULL WHERE "id" = ${id}::uuid`,
    ).rejects.toThrow(/payments_exchange_rate_check/);
    await expect(
      raw.$executeRaw`UPDATE "payments" SET "exchangeRateCurrency" = 'VES' WHERE "id" = ${id}::uuid`,
    ).rejects.toThrow(/payments_exchange_rate_check/);
    await expect(
      raw.$executeRaw`UPDATE "payments" SET "exchangeRateCurrency" = 'XXX', "exchangeRateFrom" = NULL, "exchangeRateTo" = NULL, "exchangeRateSource" = NULL, "exchangeRateDate" = NULL, "exchangeRateRef" = NULL WHERE "id" = ${id}::uuid`,
    ).rejects.toThrow(/payments_exchange_rate_currency_fkey/);
  });

  it('los índices parciales de la tasa existen y son válidos', async () => {
    const rows = await raw.$queryRaw<{ name: string; valid: boolean }[]>`
      SELECT c.relname AS name, i.indisvalid AS valid
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname IN ('payments_exchange_rate_pending_idx',
                           'payments_exchange_rate_manual_idx')
       ORDER BY c.relname`;
    expect(rows).toEqual([
      { name: 'payments_exchange_rate_manual_idx', valid: true },
      { name: 'payments_exchange_rate_pending_idx', valid: true },
    ]);
  });
  describe('qué tasa y cuándo (DX-586)', () => {
    const moment = (id: string) =>
      raw.payment.findUniqueOrThrow({
        where: { id },
        select: {
          exchangeRateRef: true,
          exchangeRateQuotedAt: true,
          exchangeRateValueDate: true,
        },
      });

    it('al congelar, el abono guarda su referencia y la BD pone el instante (que luego no cambia)', async () => {
      const before = Date.now();
      const id = await pay(auto, 4000, DAY);
      const row = await moment(id);
      expect(row.exchangeRateRef).toBe(`AUTOMATIC:${DAY}`);
      expect(row.exchangeRateValueDate).toBeNull();
      expect(row.exchangeRateQuotedAt!.getTime()).toBeGreaterThanOrEqual(
        before - 60_000,
      );
      // Ni la API ni nadie lo reescribe.
      await raw.$executeRaw`UPDATE "payments" SET "exchangeRateQuotedAt" = '2000-01-01T00:00:00Z' WHERE "id" = ${id}::uuid`;
      expect((await moment(id)).exchangeRateQuotedAt).toEqual(
        row.exchangeRateQuotedAt,
      );
    });

    it('un abono sin tasa no tiene referencia ni instante; el barrido los pone al congelar', async () => {
      const id = await pay(auto, 80000, OTHER_DAY, null);
      expect(await moment(id)).toEqual({
        exchangeRateRef: null,
        exchangeRateQuotedAt: null,
        exchangeRateValueDate: null,
      });
      await inClinic(auto, () => rebalancer.freezeAllPending());
      const row = await moment(id);
      expect(row.exchangeRateRef).toBe(`AUTOMATIC:${OTHER_DAY}`);
      expect(row.exchangeRateQuotedAt).not.toBeNull();
    });

    it('el CHECK: referencia e instante juntos, con tasa, y fecha valor solo con BCV', async () => {
      const id = await pay(auto, 4000, DAY);
      await expect(
        raw.$executeRaw`UPDATE "payments" SET "exchangeRateValueDate" = '2026-10-28' WHERE "id" = ${id}::uuid`,
      ).rejects.toThrow(/payments_exchange_rate_moment_check/);
      await expect(
        raw.$executeRaw`UPDATE "payments" SET "exchangeRateRef" = '' WHERE "id" = ${id}::uuid`,
      ).rejects.toThrow(/payments_exchange_rate_moment_check/);
      const plain = await pay(auto, 4000, DAY, null);
      await expect(
        raw.$executeRaw`UPDATE "payments" SET "exchangeRateRef" = 'AUTOMATIC:2026-10-29' WHERE "id" = ${plain}::uuid`,
      ).rejects.toThrow(/payments_exchange_rate_moment_check/);
    });

    it('dos tasas manuales el mismo día: la usada no se cambia y la otra sí (también en la BD)', async () => {
      const used = await inClinic(manual, () =>
        manualRepo.create({
          date: OTHER_DAY,
          currency: 'EUR',
          rate: 0.91,
          effectiveFrom: new Date(`${OTHER_DAY}T12:00:00.000Z`),
          createdById: manual.userId,
        }),
      );
      const unused = await inClinic(manual, () =>
        manualRepo.create({
          date: OTHER_DAY,
          currency: 'EUR',
          rate: 0.92,
          effectiveFrom: new Date(`${OTHER_DAY}T18:30:00.000Z`),
          createdById: manual.userId,
        }),
      );
      // Un abono en EUR congelado con la de las 12:00 (su referencia).
      await raw.$executeRaw`
        INSERT INTO "payments" ("id", "tenantId", "locationId", "treatmentPlanId", "patientId", "amount", "currency", "paidAt", "updatedAt",
                                "exchangeRateCurrency", "exchangeRateFrom", "exchangeRateTo", "exchangeRateSource", "exchangeRateDate", "exchangeRateRef")
        SELECT gen_random_uuid(), ${manual.tenantId}::uuid, l."id", ${manual.planId}::uuid, ${manual.patientId}::uuid, 10, 'EUR',
               ${`${OTHER_DAY}T16:00:00.000Z`}::timestamp, now(), 'USD', 0.91, 1, 'MANUAL', ${OTHER_DAY}::date, ${`MANUAL:${used.id}`}
          FROM "locations" l WHERE l."tenantId" = ${manual.tenantId}::uuid LIMIT 1`;
      await expect(
        inClinic(manual, () => manualRepo.correct(used.id, 0.95)),
      ).rejects.toBeInstanceOf(ManualExchangeRateInUseError);
      await expect(
        raw.$executeRaw`UPDATE "manual_exchange_rates" SET "rate" = 0.95 WHERE "id" = ${used.id}::uuid`,
      ).rejects.toThrow(/DX-375/);
      await expect(
        inClinic(manual, () => manualRepo.correct(unused.id, 0.93)),
      ).resolves.toMatchObject({ rate: 0.93 });
      const listed = await inClinic(manual, () =>
        manualRepo.listDay(OTHER_DAY),
      );
      expect(
        listed.filter((r) => r.currency === 'EUR').map((r) => [r.id, r.inUse]),
      ).toEqual([
        [used.id, true],
        [unused.id, false],
      ]);
    });

    it('una réplica anterior que inserta sin hora: rige desde el inicio del día en la sede principal (Caracas)', async () => {
      const membership = await raw.clinicMembership.findFirstOrThrow({
        where: { tenantId: manual.tenantId },
      });
      await raw.$executeRaw`
        INSERT INTO "manual_exchange_rates" ("id", "tenantId", "date", "currency", "rate", "createdById", "createdByMembershipId")
        VALUES (gen_random_uuid(), ${manual.tenantId}::uuid, '2026-10-20', 'GBP', 3900, ${manual.userId}::uuid, ${membership.id}::uuid)`;
      const row = await raw.manualExchangeRate.findFirstOrThrow({
        where: { tenantId: manual.tenantId, currency: 'GBP' },
      });
      expect(row.effectiveFrom.toISOString()).toBe('2026-10-20T04:00:00.000Z');
      // Una segunda sin hora del mismo día choca con el único nuevo.
      await expect(
        raw.$executeRaw`
          INSERT INTO "manual_exchange_rates" ("id", "tenantId", "date", "currency", "rate", "createdById", "createdByMembershipId")
          VALUES (gen_random_uuid(), ${manual.tenantId}::uuid, '2026-10-20', 'GBP', 3950, ${manual.userId}::uuid, ${membership.id}::uuid)`,
      ).rejects.toThrow(/"tenantId", currency, "effectiveFrom"/);
    });
  });
});
