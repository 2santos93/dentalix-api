import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import type { RecordAuditEventUseCase } from '../src/modules/audit/application/record-audit-event.use-case';
import { ExchangeSourceChangeHooks } from '../src/modules/exchange/application/exchange-source-change-hooks';
import { UpdateExchangeRateSettingsUseCase } from '../src/modules/exchange/application/use-cases/exchange-rate-settings.use-cases';
import { GetExchangeHeaderUseCase } from '../src/modules/exchange/application/use-cases/get-exchange-header.use-case';
import { GetRatesForDateUseCase } from '../src/modules/exchange/application/use-cases/get-rates-for-date.use-case';
import { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import { PrismaBcvRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-bcv-rate.repository';
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

// DX-585 contra Postgres: la tabla global `bcv_rate_snapshots` (PK por fecha
// valor, CHECK de tasas y origen, la app sin DELETE), el repositorio (la que
// rige un día: fecha valor <= día, la más reciente, con tope de antigüedad),
// la fuente BCV en `tenants` (manualSince NULL con el CHECK de DX-374, evento
// de auditoría) y las tasas y el menú de un fin de semana con la del último
// día hábil. Fechas de 2031: no chocan con las de otros specs.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const bcvRepo = new PrismaBcvRateRepository(prisma);
const settingsRepo = new PrismaClinicExchangeSettingsRepository(
  prisma,
  tenantContext,
);
const snapshotsRepo = new PrismaExchangeRateRepository(prisma);
const PREFIX = 'dx585-int';
// 2031-03-07 es viernes; el 08 y 09, fin de semana; el 10, lunes.
const FRIDAY = '2031-03-07';
const SUNDAY = '2031-03-09';
const MONDAY = '2031-03-10';
const NOW = new Date('2031-03-09T16:00:00.000Z');
const DATES = [FRIDAY, MONDAY, '2031-02-20', '2031-03-01'];
const dateColumn = (day: string) => new Date(`${day}T00:00:00.000Z`);

const rates = new GetRatesForDateUseCase(
  snapshotsRepo,
  { fetchRates: () => Promise.reject(new Error('el proveedor no se toca')) },
  settingsRepo,
  new PrismaManualExchangeRateRepository(prisma, tenantContext),
  tenantContext,
  undefined,
  () => NOW,
  undefined,
  bcvRepo,
);
const header = new GetExchangeHeaderUseCase(
  new PrismaClinicCurrenciesRepository(prisma, tenantContext),
  new PrismaClinicCurrencyTextsRepository(prisma, tenantContext),
  settingsRepo,
  snapshotsRepo,
  rates,
  () => NOW,
);

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
  await raw.bcvRateSnapshot.deleteMany({
    where: { valueDate: { in: DATES.map(dateColumn) } },
  });
}

describe('Fuente BCV (DX-585, int)', () => {
  let tenantId: string;
  let userId: string;
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const inClinic = <T>(fn: () => Promise<T>) => tenantContext.run(tenantId, fn);
  const ctx = (): AuditRequestContext => ({
    tenantId,
    locationId: null,
    actor: { userId, role: 'ADMIN' },
    requestId: 'req-int',
    ip: null,
    userAgent: null,
  });

  beforeAll(async () => {
    await cleanup();
    const tenant = await raw.tenant.create({
      data: {
        name: `${PREFIX}-ve`,
        subdomain: `${PREFIX}-ve`,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        acceptedCurrencies: ['USD', 'VES', 'EUR'],
      },
    });
    tenantId = tenant.id;
    userId = (
      await raw.user.create({
        data: {
          email: `${PREFIX}@example.com`,
          fullName: 'Admin',
          passwordHash: 'x',
        },
      })
    ).id;
    await raw.clinicMembership.create({
      data: { tenantId, userId, role: 'ADMIN' },
    });
    await raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId,
        name: 'Sede Caracas',
        currency: 'VES',
      }),
    });
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  describe('tabla bcv_rate_snapshots', () => {
    it('el repositorio guarda y corrige por fecha valor (upsert) con la conexión de la app', async () => {
      await bcvRepo.upsert({
        valueDate: FRIDAY,
        usdVes: 918.5,
        eurVes: 1011,
        fetchedAt: new Date('2031-03-06T20:00:00.000Z'),
        origin: 'FALLBACK',
      });
      await bcvRepo.upsert({
        valueDate: FRIDAY,
        usdVes: 918.7662,
        eurVes: 1011.17949056,
        fetchedAt: new Date('2031-03-06T21:00:00.000Z'),
        origin: 'BCV',
      });
      await bcvRepo.upsert({
        valueDate: MONDAY,
        usdVes: 925,
        eurVes: 1020,
        fetchedAt: new Date('2031-03-07T20:00:00.000Z'),
        origin: 'BCV',
      });
      const rows = await raw.bcvRateSnapshot.findMany({
        where: { valueDate: { in: [FRIDAY, MONDAY].map(dateColumn) } },
        orderBy: { valueDate: 'asc' },
      });
      expect(
        rows.map((r) => [
          r.valueDate.toISOString().slice(0, 10),
          r.usdVes.toString(),
          r.eurVes.toString(),
          r.origin,
        ]),
      ).toEqual([
        [FRIDAY, '918.7662', '1011.17949056', 'BCV'],
        [MONDAY, '925', '1020', 'BCV'],
      ]);
    });

    it('la que rige un día: fecha valor <= el día, la más reciente, y no más vieja que el tope', async () => {
      await expect(
        bcvRepo.inForce(SUNDAY, '2031-03-02'),
      ).resolves.toMatchObject({
        valueDate: FRIDAY,
        usdVes: 918.7662,
        eurVes: 1011.17949056,
        origin: 'BCV',
        fetchedAt: new Date('2031-03-06T21:00:00.000Z'),
      });
      await expect(
        bcvRepo.inForce(MONDAY, '2031-03-03'),
      ).resolves.toMatchObject({
        valueDate: MONDAY,
      });
      await expect(
        bcvRepo.inForce('2031-03-20', '2031-03-13'),
      ).resolves.toBeNull();
      await expect(bcvRepo.latestUpTo(SUNDAY)).resolves.toMatchObject({
        valueDate: FRIDAY,
      });
    });

    it('los CHECK rechazan tasas <= 0 y un origen desconocido; la PK, dos filas de la misma fecha valor', async () => {
      const insert = (
        usd: string,
        eur: string,
        origin: string,
        day = '2031-02-20',
      ) =>
        raw.$executeRaw`INSERT INTO "bcv_rate_snapshots" ("valueDate", "usdVes", "eurVes", "fetchedAt", "origin")
          VALUES (${day}::date, ${usd}::numeric, ${eur}::numeric, now(), ${origin})`;
      await expect(insert('0', '1', 'BCV')).rejects.toThrow(
        /bcv_rate_snapshots_rates_check/,
      );
      await expect(insert('1', '-1', 'BCV')).rejects.toThrow(
        /bcv_rate_snapshots_rates_check/,
      );
      await expect(insert('1', '1', 'PARALELO')).rejects.toThrow(
        /bcv_rate_snapshots_origin_check/,
      );
      await expect(insert('1', '1', 'BCV', FRIDAY)).rejects.toThrow(
        /23505|already exists/,
      );
    });

    it('dentalix_app lee, inserta y actualiza, pero no borra ni vacía; sin RLS (global)', async () => {
      const [row] = await raw.$queryRaw<
        { select: boolean; write: boolean; delete: boolean; rls: boolean }[]
      >`
        SELECT has_table_privilege('dentalix_app', 'public.bcv_rate_snapshots', 'SELECT') AS select,
               has_table_privilege('dentalix_app', 'public.bcv_rate_snapshots', 'INSERT,UPDATE') AS write,
               has_table_privilege('dentalix_app', 'public.bcv_rate_snapshots', 'DELETE,TRUNCATE') AS delete,
               (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bcv_rate_snapshots'::regclass) AS rls`;
      expect(row).toEqual({
        select: true,
        write: true,
        delete: false,
        rls: false,
      });
      await expect(
        prisma.bcvRateSnapshot.deleteMany({
          where: { valueDate: dateColumn(MONDAY) },
        }),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('la clínica con fuente BCV', () => {
    it('pasar a BCV guarda manualSince NULL (cumple el CHECK de DX-374) y deja el evento de la fuente', async () => {
      const hooks = new ExchangeSourceChangeHooks();
      const before = jest.fn().mockResolvedValue(undefined);
      hooks.register(before);
      const update = new UpdateExchangeRateSettingsUseCase(
        settingsRepo,
        audit as unknown as RecordAuditEventUseCase,
        () => NOW,
        hooks,
        new PrismaClinicCurrenciesRepository(prisma, tenantContext),
      );
      await inClinic(() => update.execute({ source: 'MANUAL' }, ctx()));
      await expect(
        inClinic(() => update.execute({ source: 'BCV' }, ctx())),
      ).resolves.toMatchObject({ source: 'BCV', manualSince: null });
      const tenant = await raw.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { exchangeRateSource: true, manualExchangeRatesSince: true },
      });
      expect(tenant).toEqual({
        exchangeRateSource: 'BCV',
        manualExchangeRatesSince: null,
      });
      expect(before).toHaveBeenCalledTimes(2);
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          metadata: {
            reason: 'EXCHANGE_RATE_SOURCE',
            statusChange: { from: 'MANUAL', to: 'BCV' },
          },
        }),
      );
      // BCV con un día de inicio viola el CHECK: solo MANUAL lo lleva.
      await expect(
        raw.tenant.update({
          where: { id: tenantId },
          data: { manualExchangeRatesSince: dateColumn(FRIDAY) },
        }),
      ).rejects.toThrow(/tenants_manual_exchange_rates_since_check/);
    });

    it('el domingo, GET /exchange/rates usa la del viernes (último día hábil) aunque la del lunes ya esté', async () => {
      await expect(
        inClinic(() =>
          rates.forRequest(SUNDAY, { currencies: ['VES', 'EUR'] }),
        ),
      ).resolves.toEqual({
        base: 'USD',
        source: 'BCV',
        rates: { VES: 918.7662, EUR: 0.90860842 },
        rateDate: SUNDAY,
        bcv: { valueDate: FRIDAY, fetchedAt: '2031-03-06T21:00:00.000Z' },
      });
    });

    it('el menú del domingo: «1 USD = 918,7662 Bs.» y «1 EUR = 1.011,18 Bs.», fuente BCV y fecha valor del viernes', async () => {
      const body = await inClinic(() => header.execute());
      expect(body.visible).toBe(true);
      expect(
        body.rates.map((r) => [r.currency, r.source, r.date, r.valueDate]),
      ).toEqual([
        ['USD', 'BCV', SUNDAY, FRIDAY],
        ['EUR', 'BCV', SUNDAY, FRIDAY],
      ]);
      expect(body.rates[0].perReference).toBe(918.7662);
      expect(body.rates[1].perReference).toBeCloseTo(1011.17949056, 3);
    });

    it('un abono en VES de un plan en USD cotiza con la del BCV y fuente BCV (lo que congela, DX-375)', async () => {
      await expect(
        inClinic(() =>
          new ConvertAmountUseCase(rates).quote({
            from: 'VES',
            to: 'USD',
            date: SUNDAY,
          }),
        ),
      ).resolves.toEqual({
        from: 'VES',
        to: 'USD',
        date: SUNDAY,
        rateDate: SUNDAY,
        source: 'BCV',
        fromPerBase: 918.7662,
        toPerBase: 1,
        // DX-586: la del viernes (su fecha valor), la que congela el abono.
        ref: `BCV:${FRIDAY}`,
        valueDate: FRIDAY,
      });
      // La columna de la tasa congelada admite la fuente nueva.
      const [{ ok }] = await raw.$queryRaw<{ ok: boolean }[]>`
        SELECT 'BCV'::"ExchangeRateSource" IS NOT NULL AS ok`;
      expect(ok).toBe(true);
    });
  });
});
