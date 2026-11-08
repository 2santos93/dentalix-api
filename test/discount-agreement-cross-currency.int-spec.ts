import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { PrismaCurrencyDigitsCatalog } from '../src/shared/money/prisma-currency-digits.catalog';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { addCivilDays } from '../src/shared/time/civil-day';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { PrismaPlanOptionsRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-plan-options.repository';
import { AddTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/add-treatment-plan-item.use-case';
import { testDiscountPolicy } from '../src/modules/treatment-plans/application/use-cases/__fixtures__/discount-fixtures';
import { catalogPricing } from '../src/modules/treatment-plans/application/use-cases/__fixtures__/catalog-pricing-source';
import { ClinicReferenceRateSource } from '../src/modules/treatment-plans/infrastructure/pricing/clinic-reference-rate-source';
import { PrismaDiscountReportRepository } from '../src/modules/discounts/infrastructure/prisma-discount-report.repository';
import { GetRatesForDateUseCase } from '../src/modules/exchange/application/use-cases/get-rates-for-date.use-case';
import { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import { GetExchangeRateSettingsUseCase } from '../src/modules/exchange/application/use-cases/exchange-rate-settings.use-cases';
import { PrismaExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-exchange-rate.repository';
import { PrismaClinicExchangeSettingsRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-clinic-exchange-settings.repository';
import { PrismaManualExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-manual-exchange-rate.repository';
import type { DentalCatalogRepository } from '../src/modules/dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogItem } from '../src/modules/dental-catalog/domain/entities/dental-catalog-item.entity';
import type { PricingSource } from '../src/modules/treatment-plans/domain/ports/pricing-source.port';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { civilDaysSince, fixedSedeDay } from './support/sede-clock';

// DX-513-ter contra Postgres. Convenio «Empresa» de LISTA en USD (corona a
// 3,50) con el catálogo de la clínica en VES (3.600,00 Bs.) y tasa MANUAL de
// 880 Bs./USD. Al dar de alta el ítem se pide la tasa del día SIN exigirla:
// con ella se congela la base convertida (4,09 USD) y el informe mide la
// rebaja de convenio (0,59 USD) sin convertir nunca; sin ella el ítem se crea
// igual y el informe lo señala «sin referencia comparable», sin importe y con
// su recuento por moneda. Repositorios, fuente de tasas y casos de uso
// reales; `raw` (DIRECT_URL, owner) siembra y comprueba. Reloj fijo.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const plans = new PrismaTreatmentPlanRepository(prisma, tenantContext);
const options = new PrismaPlanOptionsRepository(prisma, tenantContext);
const report = new PrismaDiscountReportRepository(prisma, tenantContext);
const policy = testDiscountPolicy();
const SEDE = fixedSedeDay();
const now = () => SEDE.at;

const settingsRepo = new PrismaClinicExchangeSettingsRepository(
  prisma,
  tenantContext,
);
const convert = new ConvertAmountUseCase(
  new GetRatesForDateUseCase(
    new PrismaExchangeRateRepository(prisma),
    { fetchRates: () => Promise.reject(new Error('el proveedor no se toca')) },
    settingsRepo,
    new PrismaManualExchangeRateRepository(prisma, tenantContext),
    tenantContext,
  ),
);
const rates = new ClinicReferenceRateSource(
  prisma,
  tenantContext,
  convert,
  new GetExchangeRateSettingsUseCase(settingsRepo),
  now,
  new PrismaCurrencyDigitsCatalog(prisma),
);

let catalogEntity: DentalCatalogItem;
const catalog = {
  findById: () => Promise.resolve(catalogEntity),
  findByIds: () => Promise.resolve([catalogEntity]),
} as unknown as DentalCatalogRepository;
const pricing: PricingSource = {
  contextFor: (patientId, catalogItemId, currency) =>
    catalogPricing(catalog, {
      locationId: s.locationId,
      catalogCurrency: 'VES',
      today: SEDE.day,
      agreement: {
        id: s.agreementId,
        name: 'Empresa',
        kind: 'PRICE_LIST',
        percent: null,
        percentByCategory: null,
        priceListId: null,
        locationId: null,
        active: true,
        validFrom: null,
        validTo: null,
        assignmentValidFrom: null,
        assignmentValidTo: null,
      },
      agreementListPrice: { price: 3.5, currency: 'USD', active: true },
    }).contextFor(patientId, catalogItemId, currency),
};
const add = new AddTreatmentPlanItemUseCase(plans, pricing, policy, now, rates);

interface Seeded {
  tenantId: string;
  userId: string;
  membershipId: string;
  patientId: string;
  catalogItemId: string;
  locationId: string;
  agreementId: string;
}
let s: Seeded;

const ADMIN = () => ({ userId: s.userId, role: ClinicRole.ADMIN });
const CROWN = () => ({ toothNumber: '11', catalogItemId: s.catalogItemId });

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(s.tenantId, undefined, fn);
}

async function plan(currency: 'USD' | 'VES'): Promise<string> {
  const created = await raw.treatmentPlan.create({
    data: { tenantId: s.tenantId, patientId: s.patientId, currency },
  });
  return created.id;
}

function period(): { from: string; to: string } {
  const days = civilDaysSince(48 * 60, REGIONAL_CARACAS_FIXTURE.timeZone);
  return { from: days[0], to: addCivilDays(days[days.length - 1], 1) };
}

async function reportFor(planIds: string[]) {
  const q = period();
  const [rows, summary] = await inTenant(() =>
    Promise.all([report.rows(q), report.summary(q)]),
  );
  return {
    rows: rows.filter((r) => planIds.includes(r.planId)),
    summary,
  };
}

async function manualRate(day: string, rate: string): Promise<string> {
  const created = await raw.manualExchangeRate.create({
    data: {
      tenantId: s.tenantId,
      date: new Date(`${day}T00:00:00Z`),
      currency: 'VES',
      rate: new Prisma.Decimal(rate),
      createdById: s.userId,
      createdByMembershipId: s.membershipId,
    },
  });
  return created.id;
}

async function noRateToday(): Promise<void> {
  await raw.manualExchangeRate.deleteMany({ where: { tenantId: s.tenantId } });
  await raw.tenant.update({
    where: { id: s.tenantId },
    data: { manualRateMaxAgeDays: 0 },
  });
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: {
      name: subdomain,
      subdomain,
      exchangeRateSource: 'MANUAL',
      manualExchangeRatesSince: new Date('2026-01-01T00:00:00Z'),
    },
  });
  const user = await raw.user.create({
    data: {
      email: `${subdomain}@int.test`,
      passwordHash: 'x',
      fullName: 'Dra. Convenio',
    },
  });
  const membership = await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'ADMIN' },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: `Sede ${subdomain}`,
      currency: 'VES',
    }),
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: 'Convenio' },
  });
  const item = await raw.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: `${subdomain}-crown`,
      kind: 'PROCEDURE',
      labelEs: 'Corona',
      color: '#123456',
      defaultPrice: 3600,
    },
  });
  const payer = await raw.payer.create({
    data: { tenantId: tenant.id, name: 'Empresa', type: 'EMPLOYER' },
  });
  const list = await raw.priceList.create({
    data: { tenantId: tenant.id, name: 'Lista Empresa', currency: 'USD' },
  });
  const agreement = await raw.agreement.create({
    data: {
      tenantId: tenant.id,
      name: 'Empresa',
      payerId: payer.id,
      kind: 'PRICE_LIST',
      priceListId: list.id,
    },
  });
  catalogEntity = { ...item, defaultPrice: 3600 };
  return {
    tenantId: tenant.id,
    userId: user.id,
    membershipId: membership.id,
    patientId: patient.id,
    catalogItemId: item.id,
    locationId: location.id,
    agreementId: agreement.id,
  };
}

/**
 * Las filas de la matriz del análisis (§1.3), escritas como las dejó la API
 * en cada época: tipo, moneda del catálogo y foto. Tasa 880 Bs./USD.
 */
interface Case {
  plan: 'USD' | 'VES';
  src: 'CATALOG' | 'PRICE_LIST' | 'AGREEMENT_PRICE_LIST' | 'AGREEMENT_PERCENT';
  cat: number;
  base: number | null;
  cc: string | null;
  price: number;
  disc?: number;
  rc: string | null;
  rip: number | null;
  bip: number | null;
  rate?: [number, number];
}
const MATRIX: Record<string, Case> = {
  A: {
    plan: 'VES',
    src: 'CATALOG',
    cat: 3600,
    base: 3600,
    cc: 'VES',
    price: 3500,
    rc: 'VES',
    rip: 3600,
    bip: 3600,
  },
  B: {
    plan: 'USD',
    src: 'CATALOG',
    cat: 3600,
    base: 3600,
    cc: 'VES',
    price: 4,
    rc: 'VES',
    rip: 4.09,
    bip: 4.09,
    rate: [880, 1],
  },
  C: {
    plan: 'USD',
    src: 'CATALOG',
    cat: 3600,
    base: 3600,
    cc: 'VES',
    price: 4,
    rc: null,
    rip: null,
    bip: null,
  },
  D: {
    plan: 'USD',
    src: 'CATALOG',
    cat: 3600,
    base: 3600,
    cc: null,
    price: 4,
    rc: null,
    rip: 3600,
    bip: 3600,
  },
  E: {
    plan: 'USD',
    src: 'PRICE_LIST',
    cat: 4.5,
    base: 3600,
    cc: 'VES',
    price: 4,
    rc: 'USD',
    rip: 4.5,
    bip: null,
  },
  F: {
    plan: 'VES',
    src: 'AGREEMENT_PRICE_LIST',
    cat: 3000,
    base: 3600,
    cc: 'VES',
    price: 3000,
    rc: 'VES',
    rip: 3000,
    bip: 3600,
  },
  G: {
    plan: 'USD',
    src: 'AGREEMENT_PRICE_LIST',
    cat: 3.5,
    base: 3600,
    cc: 'VES',
    price: 3.5,
    rc: 'USD',
    rip: 3.5,
    bip: null,
  },
  G2: {
    plan: 'USD',
    src: 'AGREEMENT_PRICE_LIST',
    cat: 3.5,
    base: 3600,
    cc: 'VES',
    price: 3.5,
    disc: 0.5,
    rc: 'USD',
    rip: 3.5,
    bip: null,
  },
  H: {
    plan: 'VES',
    src: 'AGREEMENT_PRICE_LIST',
    cat: 3500,
    base: 4.5,
    cc: 'USD',
    price: 3500,
    rc: 'VES',
    rip: 3500,
    bip: null,
  },
  I: {
    plan: 'USD',
    src: 'AGREEMENT_PRICE_LIST',
    cat: 3.5,
    base: 3600,
    cc: 'VES',
    price: 3.5,
    rc: null,
    rip: null,
    bip: null,
  },
  J: {
    plan: 'USD',
    src: 'AGREEMENT_PERCENT',
    cat: 3240,
    base: 3600,
    cc: 'VES',
    price: 3.68,
    rc: 'VES',
    rip: 3.68,
    bip: 4.09,
    rate: [880, 1],
  },
  K: {
    plan: 'USD',
    src: 'AGREEMENT_PERCENT',
    cat: 3240,
    base: 3600,
    cc: 'VES',
    price: 3.68,
    rc: null,
    rip: null,
    bip: null,
  },
  L: {
    plan: 'USD',
    src: 'AGREEMENT_PRICE_LIST',
    cat: 3.5,
    base: 3600,
    cc: null,
    price: 3.5,
    rc: 'USD',
    rip: 3.5,
    bip: 3600,
  },
  M: {
    plan: 'USD',
    src: 'AGREEMENT_PRICE_LIST',
    cat: 5,
    base: 3600,
    cc: 'VES',
    price: 5,
    rc: 'USD',
    rip: 5,
    bip: 4.09,
    rate: [880, 1],
  },
  N: {
    plan: 'USD',
    src: 'AGREEMENT_PRICE_LIST',
    cat: 3.5,
    base: 3600,
    cc: 'VES',
    price: 3.5,
    rc: 'USD',
    rip: 3.5,
    bip: 4.09,
    rate: [880, 1],
  },
  O: {
    plan: 'VES',
    src: 'AGREEMENT_PRICE_LIST',
    cat: 3500,
    base: 4.5,
    cc: 'USD',
    price: 3500,
    rc: 'VES',
    rip: 3500,
    bip: 3960,
    rate: [1, 880],
  },
  // Convenios anteriores a DX-513-bis (sin foto) en la misma moneda (F0): se
  // miden como hoy. DX-513-quater: una lista de convenio con la moneda del
  // catálogo NULL (L0, sin foto) es «sin referencia comparable».
  F0: {
    plan: 'VES',
    src: 'AGREEMENT_PRICE_LIST',
    cat: 3000,
    base: 3600,
    cc: 'VES',
    price: 3000,
    rc: null,
    rip: null,
    bip: null,
  },
  L0: {
    plan: 'USD',
    src: 'AGREEMENT_PRICE_LIST',
    cat: 3.5,
    base: 3600,
    cc: null,
    price: 3.5,
    rc: null,
    rip: null,
    bip: null,
  },
  // DX-513-quater: moneda del catálogo NULL. L1 (plan en VES) ni entra en el
  // informe; L2 tiene la misma forma que L (el catálogo podría ser USD):
  // tampoco se mide; L3 lleva además un descuento propio; L4 no tiene base
  // (nada que comparar); P0 y P1 (convenio por %) se siguen midiendo.
  L1: {
    plan: 'VES',
    src: 'AGREEMENT_PRICE_LIST',
    cat: 40000,
    base: 50,
    cc: null,
    price: 40000,
    rc: 'VES',
    rip: 40000,
    bip: 50,
  },
  L2: {
    plan: 'USD',
    src: 'AGREEMENT_PRICE_LIST',
    cat: 40,
    base: 50,
    cc: null,
    price: 40,
    rc: 'USD',
    rip: 40,
    bip: 50,
  },
  L3: {
    plan: 'USD',
    src: 'AGREEMENT_PRICE_LIST',
    cat: 3.5,
    base: 3600,
    cc: null,
    price: 3.5,
    disc: 0.5,
    rc: 'USD',
    rip: 3.5,
    bip: 3600,
  },
  L4: {
    plan: 'USD',
    src: 'AGREEMENT_PRICE_LIST',
    cat: 3.5,
    base: null,
    cc: null,
    price: 3.5,
    disc: 0.5,
    rc: 'USD',
    rip: 3.5,
    bip: null,
  },
  P0: {
    plan: 'USD',
    src: 'AGREEMENT_PERCENT',
    cat: 3240,
    base: 3600,
    cc: null,
    price: 3240,
    rc: null,
    rip: 3240,
    bip: 3600,
  },
  P1: {
    plan: 'USD',
    src: 'AGREEMENT_PERCENT',
    cat: 3240,
    base: 3600,
    cc: null,
    price: 3240,
    rc: null,
    rip: null,
    bip: null,
  },
};

/** Siembra la matriz: un ítem por caso, con el código en `notes`. */
async function seedMatrix(): Promise<{
  usd: string;
  ves: string;
  byId: Map<string, string>;
}> {
  const usd = await plan('USD');
  const ves = await plan('VES');
  const byId = new Map<string, string>();
  for (const [code, c] of Object.entries(MATRIX)) {
    const agreement = c.src.startsWith('AGREEMENT');
    const created = await raw.treatmentPlanItem.create({
      data: {
        tenantId: s.tenantId,
        planId: c.plan === 'USD' ? usd : ves,
        toothNumber: '11',
        catalogItemId: s.catalogItemId,
        catalogPrice: c.cat,
        basePrice: c.base,
        catalogCurrency: c.cc,
        priceSource: c.src,
        agreementId: agreement ? s.agreementId : null,
        agreementName: agreement ? 'Empresa' : null,
        price: c.price,
        discount: c.disc ?? 0,
        referenceCurrency: c.rc,
        referencePriceInPlan: c.rip,
        basePriceInPlan: c.bip,
        referenceRateFrom: c.rate?.[0] ?? null,
        referenceRateTo: c.rate?.[1] ?? null,
        referenceRateSource: c.rate ? 'MANUAL' : null,
        referenceRateDate: c.rate ? new Date(`${SEDE.day}T00:00:00Z`) : null,
        notes: code,
      },
    });
    byId.set(created.id, code);
  }
  return { usd, ves, byId };
}

const AMOUNTS_SIG = (tenantId: string) => raw.$queryRaw<{ sig: string }[]>`
  SELECT md5(string_agg(concat_ws('|', "id", "price", "discount",
             "catalogPrice", "basePrice", "catalogCurrency", "referenceCurrency",
             "referencePriceInPlan", "basePriceInPlan", "referenceRateFrom",
             "referenceRateTo", "referenceRateSource", "referenceRateDate"),
             ',' ORDER BY "id")) AS sig
    FROM "treatment_plan_items"
   WHERE "tenantId" = ${tenantId}::uuid`;

const MIGRATIONS = join(__dirname, '../prisma/migrations');
const CREATE_IDX = '20261202090000_dx513t_agreement_ref_reduction_idx';
const DROP_IDX = '20261202090100_dx513t_agreement_reduction_idx_drop_old';
const NEW_IDX = 'treatment_plan_items_tenant_agreement_ref_reduction_at_idx';
const OLD_IDX = 'treatment_plan_items_tenant_agreement_reduction_at_idx';
const migrationSql = (m: string) =>
  readFileSync(join(MIGRATIONS, m, 'migration.sql'), 'utf8')
    .replace(/--[^\n]*/g, '')
    .trim();

describe('rebaja de convenio entre monedas en las listas (DX-513-ter, Postgres)', () => {
  let seq = 0;
  beforeAll(async () => {
    await resetDatabase(raw);
  });

  beforeEach(async () => {
    catalogEntity = undefined as unknown as DentalCatalogItem;
    s = await seedClinic(`dx513t-int-${++seq}`);
    await manualRate(SEDE.day, '880');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  describe('alta por el caso de uso real', () => {
    it('con tasa: la base 4,09 USD y la tasa quedan en la fila; el informe mide 0,59 (14,43 %)', async () => {
      const usd = await plan('USD');
      const item = await inTenant(() => add.execute(usd, CROWN(), ADMIN()));
      expect(item).toMatchObject({
        price: 3.5,
        referencePriceInPlan: 3.5,
        basePriceInPlan: 4.09,
        referenceRate: null,
        baseRate: {
          fromPerBase: 880,
          toPerBase: 1,
          source: 'MANUAL',
          rateDate: SEDE.day,
        },
      });
      const { rows, summary } = await reportFor([usd]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        agreementReduction: 0.59,
        agreementUnmeasured: false,
        basePriceInPlan: 4.09,
        rate: null,
        baseRate: { fromPerBase: 880, toPerBase: 1, rateDate: SEDE.day },
      });
      expect(summary.agreementTotals).toEqual([
        { currency: 'USD', items: 1, reduction: 0.59 },
      ]);
      expect(summary.agreementUnmeasuredTotals).toEqual([]);
    });

    it('sin tasa: el ítem se crea igual, sin base; el informe lo señala sin importe', async () => {
      await noRateToday();
      const usd = await plan('USD');
      await expect(
        inTenant(() => add.execute(usd, CROWN(), ADMIN())),
      ).resolves.toMatchObject({ basePriceInPlan: null, baseRate: null });
      const { rows, summary } = await reportFor([usd]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        agreementReduction: 0,
        agreementUnmeasured: true,
        rate: null,
        baseRate: null,
      });
      expect(summary.agreementTotals).toEqual([]);
      expect(summary.agreementUnmeasuredTotals).toEqual([
        { currency: 'USD', items: 1 },
      ]);
    });

    it('test 9: corregir la tasa del día después del alta no cambia el informe (nunca convierte al consultar)', async () => {
      const usd = await plan('USD');
      await inTenant(() => add.execute(usd, CROWN(), ADMIN()));
      const before = await reportFor([usd]);
      await raw.manualExchangeRate.updateMany({
        where: { tenantId: s.tenantId },
        data: { rate: new Prisma.Decimal('1000') },
      });
      const after = await reportFor([usd]);
      expect(after.rows).toEqual(before.rows);
      expect(after.summary).toEqual(before.summary);
      expect(after.rows[0].agreementReduction).toBe(0.59);
    });

    it('test 7: la alternativa copia la base y la tasa, y se mide igual', async () => {
      const usd = await plan('USD');
      await inTenant(() => add.execute(usd, CROWN(), ADMIN()));
      const alternative = await inTenant(() =>
        options.createAlternative(usd, () => ({
          sourceLabel: 'Opción A',
          label: 'Opción B',
          createdById: s.userId,
        })),
      );
      const columns = {
        basePriceInPlan: true,
        referencePriceInPlan: true,
        referenceRateFrom: true,
        referenceRateTo: true,
        referenceRateSource: true,
        referenceRateDate: true,
      } as const;
      const [source] = await raw.treatmentPlanItem.findMany({
        where: { planId: usd },
        select: columns,
      });
      const [copy] = await raw.treatmentPlanItem.findMany({
        where: { planId: alternative!.id },
        select: columns,
      });
      expect(copy).toEqual(source);
      expect(copy.basePriceInPlan?.toNumber()).toBe(4.09);
      const { rows } = await reportFor([usd, alternative!.id]);
      expect(
        rows.map((r) => [r.agreementReduction, r.agreementUnmeasured]),
      ).toEqual([
        [0.59, false],
        [0.59, false],
      ]);
    });

    it('test 11: la base de una lista con foto no se puede añadir después (restrict_violation)', async () => {
      await noRateToday();
      const usd = await plan('USD');
      const item = await inTenant(() => add.execute(usd, CROWN(), ADMIN()));
      await expect(
        raw.treatmentPlanItem.update({
          where: { id: item.id },
          data: { basePriceInPlan: 4.09 },
        }),
      ).rejects.toThrow(/queda fijada al escribirla/);
    });
  });

  it('test 8: la matriz del análisis, con las cifras exactas', async () => {
    const { usd, ves, byId } = await seedMatrix();
    const { rows, summary } = await reportFor([usd, ves]);
    const shown = Object.fromEntries(
      rows.map((r) => [
        byId.get(r.itemId)!,
        [r.discount, r.agreementReduction, r.agreementUnmeasured],
      ]),
    );
    expect(shown).toEqual({
      A: [100, 0, false],
      B: [0.09, 0, false],
      D: [3596, 0, false],
      E: [0.5, 0, false],
      F: [0, 600, false],
      F0: [0, 600, false],
      G: [0, 0, true],
      G2: [0.5, 0, true],
      H: [0, 0, true],
      I: [0, 0, true],
      J: [0, 0.41, false],
      K: [0, 0, true],
      L: [0, 0, true],
      L0: [0, 0, true],
      L2: [0, 0, true],
      L3: [0.5, 0, true],
      L4: [0.5, 0, false],
      N: [0, 0.59, false],
      O: [0, 460, false],
      P0: [0, 360, false],
      P1: [0, 360, false],
    });
    // C (sin foto, otra moneda) y M (lista por encima del catálogo
    // convertido) no salen: ni descuento ni rebaja de convenio.
    expect(Object.keys(shown)).not.toContain('C');
    expect(Object.keys(shown)).not.toContain('M');
    // L1 (plan en VES, catálogo NULL): ni entra, como antes.
    expect(Object.keys(shown)).not.toContain('L1');
    // Las tasas: la de la referencia (B, J) en `rate`; la de la base de una
    // lista de convenio (N, O) en `baseRate`; nunca las dos.
    const byCode = (code: string) =>
      rows.find((r) => byId.get(r.itemId) === code)!;
    expect(byCode('B')).toMatchObject({
      rate: { fromPerBase: 880, toPerBase: 1 },
      baseRate: null,
    });
    expect(byCode('J')).toMatchObject({
      rate: { fromPerBase: 880 },
      baseRate: null,
    });
    expect(byCode('N')).toMatchObject({
      rate: null,
      baseRate: { fromPerBase: 880, toPerBase: 1 },
    });
    expect(byCode('O')).toMatchObject({
      rate: null,
      baseRate: { fromPerBase: 1, toPerBase: 880 },
    });
    // Totales: los de descuento (A–E y G2, más L3 y L4 con su 0,50 propio) y
    // los de convenio (J, N y los dos por %; L, L0, L2 y L3 ya NO suman,
    // DX-513-quater); las señaladas, aparte. El tope de D no se toca.
    expect(summary.totals).toEqual([
      { currency: 'USD', items: 6, gross: 3619.09, discount: 3598.09 },
      { currency: 'VES', items: 1, gross: 3600, discount: 100 },
    ]);
    expect(summary.agreementTotals).toEqual([
      { currency: 'USD', items: 4, reduction: 721 },
      { currency: 'VES', items: 3, reduction: 1660 },
    ]);
    expect(summary.agreementUnmeasuredTotals).toEqual([
      { currency: 'USD', items: 8 },
      { currency: 'VES', items: 1 },
    ]);
    expect(summary.rows).toBe(21);
  });

  it('test 8: con `professionalId`, una señalada cuenta si esa persona creó el ítem', async () => {
    const usd = await plan('USD');
    await noRateToday();
    await inTenant(() => add.execute(usd, CROWN(), ADMIN()));
    const q = period();
    const mine = await inTenant(() =>
      report.summary({ ...q, professionalId: s.userId }),
    );
    expect(mine.agreementUnmeasuredTotals).toEqual([
      { currency: 'USD', items: 1 },
    ]);
    const other = await inTenant(() =>
      report.summary({
        ...q,
        professionalId: '00000000-0000-4000-8000-000000000000',
      }),
    );
    expect(other.agreementUnmeasuredTotals).toEqual([]);
    expect(other.rows).toBe(0);
  });

  it('DX-513-quater: una lista con la moneda del catálogo NULL queda sin referencia aunque después se fije; la nueva se mide', async () => {
    const usd = await plan('USD');
    const old = await raw.treatmentPlanItem.create({
      data: {
        tenantId: s.tenantId,
        planId: usd,
        toothNumber: '11',
        catalogItemId: s.catalogItemId,
        catalogPrice: 3.5,
        basePrice: 3600,
        catalogCurrency: null,
        priceSource: 'AGREEMENT_PRICE_LIST',
        agreementId: s.agreementId,
        agreementName: 'Empresa',
        price: 3.5,
        referenceCurrency: 'USD',
        referencePriceInPlan: 3.5,
        basePriceInPlan: 3600,
      },
    });
    // La clínica fija ahora la moneda del catálogo (DX-502-bis) y un ítem
    // nuevo, con el catálogo en USD y la lista en USD, sí se mide.
    await raw.tenant.update({
      where: { id: s.tenantId },
      data: { catalogCurrency: 'USD' },
    });
    const fresh = await raw.treatmentPlanItem.create({
      data: {
        tenantId: s.tenantId,
        planId: usd,
        toothNumber: '12',
        catalogItemId: s.catalogItemId,
        catalogPrice: 40,
        basePrice: 50,
        catalogCurrency: 'USD',
        priceSource: 'AGREEMENT_PRICE_LIST',
        agreementId: s.agreementId,
        agreementName: 'Empresa',
        price: 40,
        referenceCurrency: 'USD',
        referencePriceInPlan: 40,
        basePriceInPlan: 50,
      },
    });
    const { rows } = await reportFor([usd]);
    const by = new Map(rows.map((r) => [r.itemId, r]));
    expect(by.get(old.id)).toMatchObject({
      agreementReduction: 0,
      agreementUnmeasured: true,
      catalogCurrency: null,
    });
    expect(by.get(fresh.id)).toMatchObject({
      agreementReduction: 10,
      agreementUnmeasured: false,
    });
  });

  it('DX-513-quater: con `professionalId`, la lista sin referencia cuenta solo para quien creó el ítem', async () => {
    const usd = await plan('USD');
    await raw.treatmentPlanItem.create({
      data: {
        tenantId: s.tenantId,
        planId: usd,
        toothNumber: '11',
        catalogItemId: s.catalogItemId,
        catalogPrice: 3.5,
        basePrice: 3600,
        catalogCurrency: null,
        priceSource: 'AGREEMENT_PRICE_LIST',
        agreementId: s.agreementId,
        agreementName: 'Empresa',
        price: 3.5,
        referenceCurrency: 'USD',
        referencePriceInPlan: 3.5,
        basePriceInPlan: 3600,
        createdById: s.userId,
      },
    });
    const q = period();
    const mine = await inTenant(() =>
      report.summary({ ...q, professionalId: s.userId }),
    );
    expect(mine.agreementUnmeasuredTotals).toEqual([
      { currency: 'USD', items: 1 },
    ]);
    expect(mine.agreementTotals).toEqual([]);
    const other = await inTenant(() =>
      report.summary({
        ...q,
        professionalId: '00000000-0000-4000-8000-000000000000',
      }),
    );
    expect(other.agreementUnmeasuredTotals).toEqual([]);
  });

  it('tests 10 y 12: la migración rehace el índice CONCURRENTLY sin tocar importes; la consulta lo usa y no recorre la tabla', async () => {
    await seedMatrix();
    // El estado anterior a la migración: el índice de SEC-047, sin el nuevo.
    await raw.$executeRawUnsafe(
      `DROP INDEX CONCURRENTLY IF EXISTS "${NEW_IDX}"`,
    );
    await raw.$executeRawUnsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${OLD_IDX}" ON "treatment_plan_items" ("tenantId", (COALESCE("discountAt", "createdAt"))) WHERE "agreementId" IS NOT NULL AND "basePrice" > "catalogPrice" AND "deletedAt" IS NULL`,
    );
    const before = await AMOUNTS_SIG(s.tenantId);
    await raw.$executeRawUnsafe(migrationSql(CREATE_IDX));
    await raw.$executeRawUnsafe(migrationSql(DROP_IDX));
    expect(await AMOUNTS_SIG(s.tenantId)).toEqual(before);
    const indexes = await raw.$queryRaw<
      { relname: string; indisvalid: boolean }[]
    >`
      SELECT c.relname, i.indisvalid
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname IN (${NEW_IDX}, ${OLD_IDX})`;
    expect(indexes).toEqual([{ relname: NEW_IDX, indisvalid: true }]);

    // La consulta usa el texto exacto del WHERE del informe.
    const repoSource = readFileSync(
      join(
        __dirname,
        '../src/modules/discounts/infrastructure/prisma-discount-report.repository.ts',
      ),
      'utf8',
    );
    const where = `(i."discount" > 0 OR i."price" < i."catalogPrice"
                OR i."price" < i."referencePriceInPlan"
                OR (i."agreementId" IS NOT NULL
                    AND (i."basePrice" > i."catalogPrice"
                         OR i."basePriceInPlan" > i."referencePriceInPlan"
                         OR (i."basePriceInPlan" IS NULL AND i."basePrice" IS NOT NULL
                             AND i."catalogCurrency" IS NOT NULL
                             AND i."referenceCurrency" IS DISTINCT FROM i."catalogCurrency"))))`;
    expect(repoSource).toContain(where);
    await raw.$executeRaw`
      INSERT INTO "treatment_plan_items"
        ("id", "tenantId", "planId", "toothNumber", "surfaces", "catalogItemId",
         "catalogPrice", "price", "discount", "updatedAt")
      SELECT gen_random_uuid(), ${s.tenantId}::uuid,
             (SELECT "id" FROM "treatment_plans" WHERE "tenantId" = ${s.tenantId}::uuid LIMIT 1),
             '18', '{}', ${s.catalogItemId}::uuid, 100, 100, 0, now()
        FROM generate_series(1, 3000)`;
    await raw.$executeRawUnsafe('ANALYZE "treatment_plan_items"');
    const from = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const to = new Date(Date.now() + 24 * 3600 * 1000);
    const explain = await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT i."id"
           FROM "treatment_plan_items" i
           JOIN "treatment_plans" p
             ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
          WHERE i."tenantId" = $1::uuid
            AND ${where}
            AND i."deletedAt" IS NULL
            AND p."deletedAt" IS NULL
            AND p."status" NOT IN ('REJECTED', 'CANCELLED')
            AND COALESCE(i."discountAt", i."createdAt") >= $2
            AND COALESCE(i."discountAt", i."createdAt") < $3`,
        s.tenantId,
        from,
        to,
      );
    });
    const planText = explain.map((r) => r['QUERY PLAN']).join('\n');
    expect(planText).toContain(
      'treatment_plan_items_tenant_effective_ref_discount_at_idx',
    );
    expect(planText).toContain(NEW_IDX);
    expect(planText).not.toMatch(/Seq Scan on treatment_plan_items/);
  });
});
