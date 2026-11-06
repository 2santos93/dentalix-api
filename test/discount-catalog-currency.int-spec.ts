import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { PrismaCurrencyDigitsCatalog } from '../src/shared/money/prisma-currency-digits.catalog';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { addCivilDays } from '../src/shared/time/civil-day';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { AddTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/add-treatment-plan-item.use-case';
import { UpdateTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan-item.use-case';
import { ApplyBulkDiscountUseCase } from '../src/modules/treatment-plans/application/use-cases/apply-bulk-discount.use-case';
import { testDiscountPolicy } from '../src/modules/treatment-plans/application/use-cases/__fixtures__/discount-fixtures';
import { catalogPricing } from '../src/modules/treatment-plans/application/use-cases/__fixtures__/catalog-pricing-source';
import { PrismaDiscountReportRepository } from '../src/modules/discounts/infrastructure/prisma-discount-report.repository';
import {
  priceBelowCatalogCapMessage,
  priceBelowCatalogReasonMessage,
} from '../src/modules/discounts/domain/effective-discount';
import type { DentalCatalogRepository } from '../src/modules/dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogItem } from '../src/modules/dental-catalog/domain/entities/dental-catalog-item.entity';
import type { PricingSource } from '../src/modules/treatment-plans/domain/ports/pricing-source.port';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { civilDaysSince } from './support/sede-clock';

// DX-513 contra Postgres: una rebaja frente a un catálogo en OTRA moneda (o en
// una que no se sabe: "catalogCurrency" NULL) no es un descuento. No pide
// motivo, no consume el tope del rol y no sale en el informe de descuentos
// (ni en sus totales). En la misma moneda, todo igual que antes (SEC-041).
// El catálogo de la clínica está en VES (3.600,00); los planes, en USD o VES.
// Repositorios y casos de uso reales; `raw` (DIRECT_URL, owner) siembra y
// comprueba.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const plans = new PrismaTreatmentPlanRepository(prisma, tenantContext);
const report = new PrismaDiscountReportRepository(prisma, tenantContext);
const policy = testDiscountPolicy();
const now = () => new Date();

let catalogEntity: DentalCatalogItem;
const catalog = {
  findById: () => Promise.resolve(catalogEntity),
  findByIds: () => Promise.resolve([catalogEntity]),
} as unknown as DentalCatalogRepository;
/** La moneda del catálogo que vería el alta (la común de las sedes). */
let catalogCurrency: string | null = 'VES';
const pricing: PricingSource = {
  contextFor: (patientId, catalogItemId, currency) =>
    catalogPricing(catalog, {
      locationId: s.locationId,
      catalogCurrency,
    }).contextFor(patientId, catalogItemId, currency),
};
const add = new AddTreatmentPlanItemUseCase(plans, pricing, policy, now);
const update = new UpdateTreatmentPlanItemUseCase(plans, catalog, policy, now);
const bulk = new ApplyBulkDiscountUseCase(
  plans,
  policy,
  now,
  catalog,
  new PrismaCurrencyDigitsCatalog(prisma),
);

interface Seeded {
  tenantId: string;
  userId: string;
  patientId: string;
  catalogItemId: string;
  locationId: string;
}
let s: Seeded;

const ADMIN = () => ({ userId: s.userId, role: ClinicRole.ADMIN });
const ASSISTANT = () => ({ userId: s.userId, role: ClinicRole.ASSISTANT });
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

/**
 * Días civiles de la sede que cubren los ítems recién creados (el informe va
 * por días): del de hace 24 h al de mañana, sin depender de la medianoche.
 */
function period(): { from: string; to: string } {
  const days = civilDaysSince(24 * 60, REGIONAL_CARACAS_FIXTURE.timeZone);
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

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const user = await raw.user.create({
    data: {
      email: `${subdomain}@int.test`,
      passwordHash: 'x',
      fullName: 'Dra. Moneda',
    },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: `Sede ${subdomain}`,
      currency: 'VES',
    }),
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: 'Moneda' },
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
  catalogEntity = { ...item, defaultPrice: 3600 };
  return {
    tenantId: tenant.id,
    userId: user.id,
    patientId: patient.id,
    catalogItemId: item.id,
    locationId: location.id,
  };
}

describe('descuento frente a un catálogo en otra moneda (DX-513, Postgres)', () => {
  let seq = 0;
  beforeAll(async () => {
    await resetDatabase(raw);
  });

  // Una clínica por test: los totales del informe son de toda la clínica.
  beforeEach(async () => {
    catalogCurrency = 'VES';
    s = await seedClinic(`dx513-int-${++seq}`);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  it('plan en USD con el catálogo en VES: sin motivo, sin tope y fuera del informe', async () => {
    const planId = await plan('USD');
    // La asistente (tope 0 %) da de alta a 80 USD frente a 3.600 VES.
    const created = await inTenant(() =>
      add.execute(planId, { ...CROWN(), price: 80 }, ASSISTANT()),
    );
    expect(created).toMatchObject({
      price: 80,
      catalogPrice: 3600,
      catalogCurrency: 'VES',
      discountReason: null,
      discountById: null,
    });
    // Ni la «rebaja» sola sale en el informe.
    expect((await reportFor([planId])).rows).toHaveLength(0);
    // Y lo baja más, sin 403.
    await inTenant(() =>
      update.execute(created.id, { price: 50 }, ASSISTANT()),
    );
    expect((await reportFor([planId])).summary).toEqual({
      totals: [],
      agreementTotals: [],
      rows: 0,
    });
    // El ADMIN aplica un 9 % en bloque sin motivo: la rebaja no se suma.
    const { items } = await inTenant(() =>
      bulk.execute(planId, { itemIds: [created.id], percent: 9 }, ADMIN()),
    );
    expect(items[0]).toMatchObject({ discount: 4.5, discountReason: null });

    // En el informe solo cuenta el descuento propio (4,50 USD), nunca la
    // «rebaja» de 3.600 VES a 50 USD.
    const { rows, summary } = await reportFor([planId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      currency: 'USD',
      catalogPrice: 3600,
      price: 50,
      priceReduction: 0,
      itemDiscount: 4.5,
      discount: 4.5,
    });
    expect(summary.totals).toEqual([
      { currency: 'USD', items: 1, gross: 50, discount: 4.5 },
    ]);
  });

  it('plan en VES con el catálogo en VES: igual que hoy (tope, motivo y en el informe)', async () => {
    const planId = await plan('VES');
    await expect(
      inTenant(() =>
        add.execute(planId, { ...CROWN(), price: 3000 }, ASSISTANT()),
      ),
    ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
    await expect(
      inTenant(() => add.execute(planId, { ...CROWN(), price: 2880 }, ADMIN())),
    ).rejects.toThrow(
      new UnprocessableEntityException(priceBelowCatalogReasonMessage(10)),
    );
    const created = await inTenant(() =>
      add.execute(
        planId,
        { ...CROWN(), price: 2880, discountReason: 'LOYALTY' },
        ADMIN(),
      ),
    );
    expect(created).toMatchObject({
      catalogCurrency: 'VES',
      discountReason: 'LOYALTY',
      discountById: s.userId,
    });
    // Edición: la asistente no puede bajarlo más.
    await expect(
      inTenant(() => update.execute(created.id, { price: 2800 }, ASSISTANT())),
    ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));

    const { rows, summary } = await reportFor([planId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      currency: 'VES',
      catalogPrice: 3600,
      price: 2880,
      priceReduction: 720,
      itemDiscount: 0,
      discount: 720,
      reason: 'LOYALTY',
    });
    expect(summary.totals).toEqual([
      { currency: 'VES', items: 1, gross: 3600, discount: 720 },
    ]);
  });

  it('catalogCurrency NULL (sedes en monedas distintas): como moneda distinta', async () => {
    catalogCurrency = null;
    const planId = await plan('VES');
    const created = await inTenant(() =>
      add.execute(planId, { ...CROWN(), price: 1 }, ASSISTANT()),
    );
    expect(created).toMatchObject({
      catalogPrice: 3600,
      catalogCurrency: null,
      discountById: null,
    });
    await inTenant(() =>
      update.execute(created.id, { price: 0.5 }, ASSISTANT()),
    );
    expect(await reportFor([planId])).toEqual({
      rows: [],
      summary: { totals: [], agreementTotals: [], rows: 0 },
    });
  });

  it('el informe mezcla bien las tres: solo el ítem en la misma moneda cuenta, y ningún importe guardado cambia', async () => {
    const usd = await plan('USD');
    const ves = await plan('VES');
    const items = [
      // USD con catálogo VES: «rebaja» de 3.600 a 80.
      { planId: usd, catalogCurrency: 'VES', price: 80 },
      // VES con catálogo VES: rebaja de 360.
      { planId: ves, catalogCurrency: 'VES', price: 3240 },
      // VES con la moneda del catálogo desconocida.
      { planId: ves, catalogCurrency: null, price: 100 },
    ];
    for (const it of items) {
      await raw.treatmentPlanItem.create({
        data: {
          tenantId: s.tenantId,
          planId: it.planId,
          toothNumber: '11',
          catalogItemId: s.catalogItemId,
          catalogPrice: 3600,
          basePrice: 3600,
          catalogCurrency: it.catalogCurrency,
          priceSource: 'CATALOG',
          price: it.price,
        },
      });
    }
    const before = await raw.$queryRaw<{ sig: string }[]>`
      SELECT md5(string_agg(concat_ws('|', "id", "price", "discount",
                 "catalogPrice", "basePrice", "catalogCurrency"), ',' ORDER BY "id")) AS sig
        FROM "treatment_plan_items" WHERE "tenantId" = ${s.tenantId}::uuid`;
    const { rows, summary } = await reportFor([usd, ves]);
    expect(rows.map((r) => [r.currency, r.price, r.discount])).toEqual([
      ['VES', 3240, 360],
    ]);
    expect(summary).toEqual({
      totals: [{ currency: 'VES', items: 1, gross: 3600, discount: 360 }],
      agreementTotals: [],
      rows: 1,
    });
    const after = await raw.$queryRaw<{ sig: string }[]>`
      SELECT md5(string_agg(concat_ws('|', "id", "price", "discount",
                 "catalogPrice", "basePrice", "catalogCurrency"), ',' ORDER BY "id")) AS sig
        FROM "treatment_plan_items" WHERE "tenantId" = ${s.tenantId}::uuid`;
    expect(after).toEqual(before);
  });

  it('lista de la sede en USD con el catálogo en VES: la rebaja frente a la lista sí cuenta y sale en el informe', async () => {
    const planId = await plan('USD');
    await raw.treatmentPlanItem.create({
      data: {
        tenantId: s.tenantId,
        planId,
        toothNumber: '11',
        catalogItemId: s.catalogItemId,
        catalogPrice: 100,
        basePrice: 3600,
        catalogCurrency: 'VES',
        priceSource: 'PRICE_LIST',
        price: 80,
      },
    });
    const { rows, summary } = await reportFor([planId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ priceReduction: 20, discount: 20 });
    expect(summary.totals).toEqual([
      { currency: 'USD', items: 1, gross: 100, discount: 20 },
    ]);
  });

  it('rebaja de convenio (SEC-047): solo con el catálogo en la moneda del plan', async () => {
    const payer = await raw.payer.create({
      data: { tenantId: s.tenantId, name: 'Seguros Caracas', type: 'INSURER' },
    });
    const agreement = await raw.agreement.create({
      data: {
        tenantId: s.tenantId,
        name: 'Seguros Caracas 10 %',
        payerId: payer.id,
        kind: 'PERCENT_DISCOUNT',
        percent: 10,
      },
    });
    const usd = await plan('USD');
    const ves = await plan('VES');
    // El 10 % sobre 3.600 VES: 3.240 en los dos planes; en el de USD, esa
    // «rebaja» de 360 es de VES y no se suma a los USD.
    for (const planId of [usd, ves]) {
      await raw.treatmentPlanItem.create({
        data: {
          tenantId: s.tenantId,
          planId,
          toothNumber: '11',
          catalogItemId: s.catalogItemId,
          catalogPrice: 3240,
          basePrice: 3600,
          catalogCurrency: 'VES',
          priceSource: 'AGREEMENT_PERCENT',
          agreementId: agreement.id,
          agreementName: agreement.name,
          price: 3240,
        },
      });
    }
    const { rows, summary } = await reportFor([usd, ves]);
    expect(rows.map((r) => [r.currency, r.agreementReduction])).toEqual([
      ['VES', 360],
    ]);
    expect(summary.agreementTotals).toEqual([
      { currency: 'VES', items: 1, reduction: 360 },
    ]);
  });
});
