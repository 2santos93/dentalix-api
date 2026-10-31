import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { GetRatesForDateUseCase } from '../src/modules/exchange/application/use-cases/get-rates-for-date.use-case';
import {
  DEFAULT_PROVIDER_RATES_LIMITS,
  ProviderRatesGate,
  type ProviderRatesCaller,
  type ProviderRatesLimits,
} from '../src/modules/exchange/application/provider-rates-gate';
import { ProviderRatesCallerScope } from '../src/modules/exchange/application/provider-rates-caller-scope';
import {
  ExchangeRateBudgetExceededError,
  type ExchangeRateProvider,
} from '../src/modules/exchange/domain/ports/exchange-rate-provider.port';
import { PrismaExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-exchange-rate.repository';
import { PrismaClinicExchangeSettingsRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-clinic-exchange-settings.repository';
import { PrismaManualExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-manual-exchange-rate.repository';
import { PrismaProviderRatesBudget } from '../src/modules/exchange/infrastructure/repositories/prisma-provider-rates-budget';
import { addCivilDays } from '../src/shared/time/civil-day';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// SEC-058 contra Postgres: el presupuesto del proveedor de tasas vive en la BD
// y lo comparten las réplicas. Cada «réplica» es un PrismaService propio (su
// pool de conexiones), su gate y sus contadores; el proveedor es un doble que
// cuenta las llamadas (nunca sale a la red). `raw` (DIRECT_URL, owner) siembra,
// observa los contadores y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY_MS = 24 * 60 * 60_000;
const NOW = new Date('2026-10-30T12:00:00.000Z');
const clock = () => NOW;
const OLD_CLINIC = new Date('2024-01-01T12:00:00.000Z');

interface Replica {
  prisma: PrismaService;
  tenantContext: TenantContextService;
  gate: ProviderRatesGate;
  scope: ProviderRatesCallerScope;
  rates: GetRatesForDateUseCase;
}

const replicas: Replica[] = [];

function replica(limits: ProviderRatesLimits): Replica {
  const tenantContext = new TenantContextService();
  const prisma = new PrismaService(tenantContext);
  const gate = new ProviderRatesGate(
    limits,
    clock,
    new PrismaProviderRatesBudget(prisma, limits, clock),
  );
  const scope = new ProviderRatesCallerScope();
  const rates = new GetRatesForDateUseCase(
    new PrismaExchangeRateRepository(prisma),
    { fetchRates: (date) => provider(date) },
    new PrismaClinicExchangeSettingsRepository(prisma, tenantContext),
    new PrismaManualExchangeRateRepository(prisma, tenantContext),
    tenantContext,
    gate,
    clock,
    scope,
  );
  const created = { prisma, tenantContext, gate, scope, rates };
  replicas.push(created);
  return created;
}

const provider = jest.fn<
  ReturnType<ExchangeRateProvider['fetchRates']>,
  Parameters<ExchangeRateProvider['fetchRates']>
>((date) =>
  Promise.resolve({
    base: 'USD',
    rates: { COP: 4000 + Number(date.slice(-2)) },
  }),
);

const limitsWith = (
  overrides: Partial<ProviderRatesLimits>,
): ProviderRatesLimits => ({ ...DEFAULT_PROVIDER_RATES_LIMITS, ...overrides });

/** Siembra como `raw` con `app.current_tenant` fijado (RLS FORCE). */
function asOwner<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return raw.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

async function seedClinic(
  subdomain: string,
  createdAt: Date = OLD_CLINIC,
): Promise<string> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain, createdAt },
  });
  await asOwner(tenant.id, (tx) =>
    tx.location.create({
      data: locationData(REGIONAL_BOGOTA_FIXTURE, {
        tenantId: tenant.id,
        name: 'Sede',
      }),
    }),
  );
  return tenant.id;
}

/** Un abono del 2000-01-03: la ventana de días de la clínica abre en el 2000. */
async function seedPaymentIn2000(tenantId: string): Promise<void> {
  await asOwner(tenantId, async (tx) => {
    const [location] = await tx.location.findMany({ where: { tenantId } });
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
    await tx.payment.create({
      data: {
        tenantId,
        locationId: location.id,
        treatmentPlanId: plan.id,
        patientId: patient.id,
        amount: 100,
        currency: 'USD',
        paidAt: new Date('2000-01-03T15:00:00.000Z'),
      },
    });
  });
}

/** `n` días distintos desde `from`, sin snapshot (se borran al empezar). */
const days = (from: string, n: number) =>
  Array.from({ length: n }, (_, i) => addCivilDays(from, i));

async function globalCalls(): Promise<number> {
  const row = await raw.exchangeProviderBudget.findUnique({
    where: { scope: 'GLOBAL' },
  });
  return row?.calls ?? 0;
}

async function resetBudgets(): Promise<void> {
  await raw.$executeRaw`TRUNCATE "exchange_provider_budget", "exchange_provider_clinic_budgets"`;
}

const fetchAs = (
  r: Replica,
  date: string,
  caller: ProviderRatesCaller,
  load: () => Promise<Record<string, number>>,
) => r.gate.fetch(date, caller, load);

const budgetError = (e: unknown) =>
  e instanceof ExchangeRateBudgetExceededError ? e : null;

describe('Presupuesto del proveedor de tasas en la BD (SEC-058, int)', () => {
  const clinics: string[] = [];
  let newClinic: string;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    await resetDatabase(raw);
    for (let i = 0; i < 10; i += 1) {
      clinics.push(await seedClinic(`sec058-int-${i}`));
    }
    newClinic = await seedClinic(
      'sec058-int-new',
      new Date(NOW.getTime() - 3 * DAY_MS),
    );
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await Promise.all(replicas.map((r) => r.prisma.$disconnect()));
    await raw.$disconnect();
    Logger.overrideLogger(true);
  });

  beforeEach(async () => {
    provider.mockClear();
    await resetBudgets();
  });

  it('dos réplicas en paralelo comparten el contador: el total nunca pasa del tope global', async () => {
    const limits = limitsWith({
      clinic: { limit: 100, windowMs: 60 * 60_000 },
      clinicDaily: 100,
      global: { limit: 25, windowMs: DAY_MS },
      sweep: { reserve: 5, clinicLimit: 5 },
    });
    const [one, two] = [replica(limits), replica(limits)];
    const load = jest.fn(() => Promise.resolve({ COP: 4000 }));
    // 120 llamadas a la vez (60 por réplica), de 10 clínicas y días distintos.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 120 }, (_, i) =>
        fetchAs(
          i % 2 ? one : two,
          addCivilDays('2001-01-01', i),
          { kind: 'CLINIC', tenantId: clinics[i % 10] },
          load,
        ),
      ),
    );

    const spent = outcomes.filter((o) => o.status === 'fulfilled').length;
    expect(spent).toBe(20); // 25 − 5 de la reserva del barrido
    expect(load).toHaveBeenCalledTimes(20);
    expect(await globalCalls()).toBe(20);
    for (const o of outcomes) {
      if (o.status === 'rejected') {
        expect(budgetError(o.reason)?.scope).toBe('GLOBAL');
      }
    }
    // Lo gastado por cada clínica suma lo mismo que el global.
    const perClinic = await raw.exchangeProviderClinicBudget.findMany({
      where: { quota: 'DAY' },
    });
    expect(perClinic.reduce((sum, row) => sum + row.calls, 0)).toBe(20);
  });

  it('una clínica con la ventana abierta en el 2000 agota su cupo, no el de las demás', async () => {
    const limits = limitsWith({
      clinic: { limit: 30, windowMs: 60 * 60_000 },
      clinicDaily: 8,
      global: { limit: 20, windowMs: DAY_MS },
      sweep: { reserve: 2, clinicLimit: 2 },
    });
    const [one, two] = [replica(limits), replica(limits)];
    const [attacker, victim] = [clinics[0], clinics[1]];
    await seedPaymentIn2000(attacker);
    const attackDays = days('2000-01-03', 30);
    const victimDays = days('2025-05-01', 3);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: [...attackDays, ...victimDays] } },
    });

    // Las rutas de tasas (`forRequest`): 30 días del 2000, desde dos réplicas.
    const attack = await Promise.allSettled(
      attackDays.map((date, i) => {
        const r = i % 2 ? one : two;
        return r.tenantContext.run(attacker, () => r.rates.forRequest(date));
      }),
    );
    expect(attack.filter((o) => o.status === 'fulfilled')).toHaveLength(8);
    for (const o of attack) {
      if (o.status === 'rejected') {
        expect(budgetError(o.reason)?.scope).toBe('CLINIC');
      }
    }
    expect(provider).toHaveBeenCalledTimes(8);

    // La otra clínica sigue obteniendo tasa, en las dos réplicas.
    for (const [i, date] of victimDays.entries()) {
      const r = i % 2 ? one : two;
      await expect(
        r.tenantContext.run(victim, () => r.rates.forRequest(date)),
      ).resolves.toMatchObject({ source: 'AUTOMATIC' });
    }
    expect(await globalCalls()).toBe(11);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: [...attackDays, ...victimDays] } },
    });
  });

  it('el barrido conserva su cupo reservado con el resto agotado', async () => {
    const limits = limitsWith({
      clinic: { limit: 100, windowMs: 60 * 60_000 },
      clinicDaily: 100,
      global: { limit: 12, windowMs: DAY_MS },
      sweep: { reserve: 4, clinicLimit: 3 },
    });
    const [one, two] = [replica(limits), replica(limits)];
    const load = jest.fn(() => Promise.resolve({ COP: 4000 }));
    for (const [i, date] of days('2002-01-01', 8).entries()) {
      await fetchAs(
        i % 2 ? one : two,
        date,
        { kind: 'CLINIC', tenantId: clinics[0] },
        load,
      );
    }
    const blocked = await fetchAs(
      one,
      '2002-02-01',
      { kind: 'CLINIC', tenantId: clinics[1] },
      load,
    ).catch((e: unknown) => e);
    expect(budgetError(blocked)?.scope).toBe('GLOBAL');

    // El barrido de reintentos (DX-380) de otra clínica: su ámbito lo marca
    // el job, y el caso de uso gasta como SWEEP.
    const sweepDays = days('2002-03-01', 4);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: sweepDays } },
    });
    const swept = await Promise.allSettled(
      sweepDays.map((date, i) => {
        const r = i % 2 ? one : two;
        return r.tenantContext.run(clinics[2], () =>
          r.scope.asSweep(() => r.rates.execute(date)),
        );
      }),
    );
    // 3 de su clínica (EXCHANGE_PROVIDER_SWEEP_CLINIC_LIMIT); la 4.ª, no.
    expect(swept.filter((o) => o.status === 'fulfilled')).toHaveLength(3);
    // Otra clínica toma la última llamada de la reserva; después, nadie.
    await expect(
      two.tenantContext.run(clinics[3], () =>
        two.scope.asSweep(() => two.rates.execute('2002-04-01')),
      ),
    ).resolves.toMatchObject({ source: 'AUTOMATIC' });
    expect(await globalCalls()).toBe(12);
    await expect(
      one.tenantContext.run(clinics[4], () =>
        one.scope.asSweep(() => one.rates.execute('2002-04-02')),
      ),
    ).rejects.toBeInstanceOf(ExchangeRateBudgetExceededError);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: [...sweepDays, '2002-04-01', '2002-04-02'] } },
    });
  });

  it('una clínica de menos de N días tiene el tope reducido (el alta sale de la BD)', async () => {
    const limits = limitsWith({
      clinicDaily: 10,
      newClinic: { days: 30, limit: 3 },
    });
    const one = replica(limits);
    const load = jest.fn(() => Promise.resolve({ COP: 4000 }));
    const outcomes = await Promise.allSettled(
      days('2004-01-01', 6).map((date) =>
        fetchAs(one, date, { kind: 'CLINIC', tenantId: newClinic }, load),
      ),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(3);
    // Una clínica antigua, con el mismo reloj, tiene el cupo normal.
    for (const date of days('2004-02-01', 6)) {
      await fetchAs(one, date, { kind: 'CLINIC', tenantId: clinics[5] }, load);
    }
    expect(load).toHaveBeenCalledTimes(9);
  });

  describe('aislamiento (rol de la app)', () => {
    const app = new PrismaService(new TenantContextService());

    afterAll(() => app.$disconnect());

    it('solo ve los contadores de su clínica y nada del global', async () => {
      const one = replica(DEFAULT_PROVIDER_RATES_LIMITS);
      const load = () => Promise.resolve({ COP: 4000 });
      await fetchAs(
        one,
        '2005-01-01',
        { kind: 'CLINIC', tenantId: clinics[6] },
        load,
      );
      await fetchAs(
        one,
        '2005-01-02',
        { kind: 'CLINIC', tenantId: clinics[7] },
        load,
      );

      const seen = await app.runWithTenant(
        clinics[6],
        (tx) =>
          tx.$queryRaw<{ tenantId: string }[]>`
          SELECT "tenantId"::text AS "tenantId" FROM "exchange_provider_clinic_budgets"`,
      );
      expect(new Set(seen.map((r) => r.tenantId))).toEqual(
        new Set([clinics[6]]),
      );
      // Sin clínica en el contexto, ninguno.
      await expect(
        app.$queryRaw`SELECT 1 FROM "exchange_provider_clinic_budgets"`,
      ).resolves.toEqual([]);

      for (const sql of [
        Prisma.sql`SELECT calls FROM "exchange_provider_budget"`,
        Prisma.sql`UPDATE "exchange_provider_budget" SET calls = 1`,
        Prisma.sql`DELETE FROM "exchange_provider_budget"`,
      ]) {
        await expect(app.$queryRaw(sql)).rejects.toThrow(/permission denied/);
      }
      // Ni puede adelantar la ventana para dejar el contador bloqueado.
      await expect(
        app.$queryRaw`SELECT dx_exchange_provider_spend_global('2100-01-01'::timestamp(3), 10)`,
      ).rejects.toThrow(/ventana en el futuro/);
      expect(await globalCalls()).toBe(2);
    });
  });
});
