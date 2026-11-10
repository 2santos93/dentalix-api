import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { PrismaCurrencyDigitsCatalog } from '../src/shared/money/prisma-currency-digits.catalog';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { addCivilDays } from '../src/shared/time/civil-day';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { PrismaPlanOptionsRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-plan-options.repository';
import { AddTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/add-treatment-plan-item.use-case';
import { UpdateTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan-item.use-case';
import {
  CURRENCY_LOCKED_BY_PRICED_ITEMS_CODE,
  UpdateTreatmentPlanUseCase,
} from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan.use-case';
import { DISCOUNT_REFERENCE_RATE_MISSING_CODE } from '../src/modules/treatment-plans/application/use-cases/reference-rate';
import { testDiscountPolicy } from '../src/modules/treatment-plans/application/use-cases/__fixtures__/discount-fixtures';
import { catalogPricing } from '../src/modules/treatment-plans/application/use-cases/__fixtures__/catalog-pricing-source';
import { ClinicReferenceRateSource } from '../src/modules/treatment-plans/infrastructure/pricing/clinic-reference-rate-source';
import { PrismaDiscountReportRepository } from '../src/modules/discounts/infrastructure/prisma-discount-report.repository';
import { priceBelowCatalogCapMessage } from '../src/modules/discounts/domain/effective-discount';
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

// DX-513-bis contra Postgres. La clínica usa tasa MANUAL (880 Bs./USD para el
// día de la sede); su catálogo está en VES (corona de 3.600,00 Bs.) o en USD
// (4,50). Al escribir un ítem cuya referencia está en otra moneda conocida se
// convierte a la del plan con esa tasa y se congela en el ítem; el tope, el
// motivo y el informe miden la rebaja frente a la referencia convertida. El
// informe nunca convierte. Un plan con ítems con referencia no cambia de
// moneda. Repositorios, fuente de tasas y casos de uso reales; `raw`
// (DIRECT_URL, owner) siembra y comprueba. Reloj fijo (DX-209).
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
let catalogCurrency: string | null = 'VES';
const pricing: PricingSource = {
  contextFor: (patientId, catalogItemId, currency) =>
    catalogPricing(catalog, {
      locationId: s.locationId,
      catalogCurrency,
      today: SEDE.day,
    }).contextFor(patientId, catalogItemId, currency),
};
const add = new AddTreatmentPlanItemUseCase(plans, pricing, policy, now, rates);
const update = new UpdateTreatmentPlanItemUseCase(
  plans,
  catalog,
  policy,
  now,
  rates,
);
const updatePlan = new UpdateTreatmentPlanUseCase(
  plans,
  { has: (code) => Promise.resolve(['USD', 'VES'].includes(code)) },
  now,
  policy,
);

interface Seeded {
  tenantId: string;
  userId: string;
  membershipId: string;
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

/** Días civiles de la sede que cubren el reloj fijo (ayer) y las altas (hoy). */
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
      fullName: 'Dra. Moneda',
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
  catalogEntity = {
    ...item,
    defaultPrice: 3600,
    suggestedClinicalNoteTemplateId: null,
  };
  return {
    tenantId: tenant.id,
    userId: user.id,
    membershipId: membership.id,
    patientId: patient.id,
    catalogItemId: item.id,
    locationId: location.id,
  };
}

/** Un ítem anterior a DX-513-bis (sin foto), escrito como lo dejaba la API. */
function legacyItem(
  planId: string,
  data: {
    price: number;
    discount?: number;
    catalogCurrency: string | null;
  },
) {
  return raw.treatmentPlanItem.create({
    data: {
      tenantId: s.tenantId,
      planId,
      toothNumber: '12',
      catalogItemId: s.catalogItemId,
      catalogPrice: 3600,
      basePrice: 3600,
      priceSource: 'CATALOG',
      ...data,
    },
  });
}

const LEGACY_SIG = (tenantId: string) => raw.$queryRaw<{ sig: string }[]>`
  SELECT md5(string_agg(concat_ws('|', "id", "price", "discount",
             "catalogPrice", "basePrice", "catalogCurrency"), ',' ORDER BY "id")) AS sig
    FROM "treatment_plan_items"
   WHERE "tenantId" = ${tenantId}::uuid AND "referencePriceInPlan" IS NULL`;

describe('referencia convertida y congelada en el ítem (DX-513-bis, Postgres)', () => {
  let seq = 0;
  beforeAll(async () => {
    await resetDatabase(raw);
  });

  beforeEach(async () => {
    catalogCurrency = 'VES';
    catalogEntity = undefined as unknown as DentalCatalogItem;
    s = await seedClinic(`dx513b-int-${++seq}`);
    await manualRate(SEDE.day, '880');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  it('test 15: el informe mezcla foto entre monedas, foto en la misma moneda, ítem anterior entre monedas y moneda NULL; totales por moneda y tasa en la fila', async () => {
    const usd = await plan('USD');
    const ves = await plan('VES');
    // Foto entre monedas: 3.600 Bs. a 880 = 4,09 USD; precio 4,00.
    const converted = await inTenant(() =>
      add.execute(usd, { ...CROWN(), price: 4 }, ADMIN()),
    );
    expect(converted).toMatchObject({
      referenceCurrency: 'VES',
      referencePriceInPlan: 4.09,
      referenceRate: {
        fromPerBase: 880,
        toPerBase: 1,
        source: 'MANUAL',
        rateDate: SEDE.day,
      },
    });
    // Foto en la misma moneda: rebaja de 360 Bs. con motivo.
    await inTenant(() =>
      add.execute(
        ves,
        { ...CROWN(), price: 3240, discountReason: 'LOYALTY' },
        ADMIN(),
      ),
    );
    // Anterior entre monedas: solo cuenta su `discount` (DX-513).
    await legacyItem(usd, { price: 80, discount: 2, catalogCurrency: 'VES' });
    // Anterior con la moneda desconocida: cifras crudas (DX-513).
    await legacyItem(usd, { price: 100, catalogCurrency: null });

    const { rows, summary } = await reportFor([usd, ves]);
    const byPrice = (p: number) => rows.find((r) => r.price === p)!;
    expect(rows).toHaveLength(4);
    expect(byPrice(4)).toMatchObject({
      currency: 'USD',
      catalogPrice: 3600,
      referenceCurrency: 'VES',
      referencePriceInPlan: 4.09,
      priceReduction: 0.09,
      discount: 0.09,
      rate: {
        fromPerBase: 880,
        toPerBase: 1,
        source: 'MANUAL',
        rateDate: SEDE.day,
      },
    });
    expect(byPrice(3240)).toMatchObject({
      currency: 'VES',
      referenceCurrency: 'VES',
      referencePriceInPlan: 3600,
      priceReduction: 360,
      rate: null,
    });
    expect(byPrice(80)).toMatchObject({
      referenceCurrency: 'VES',
      referencePriceInPlan: null,
      priceReduction: 0,
      discount: 2,
      rate: null,
    });
    expect(byPrice(100)).toMatchObject({
      referenceCurrency: null,
      priceReduction: 3500,
    });
    expect(summary.totals).toEqual([
      { currency: 'USD', items: 3, gross: 3684.09, discount: 3502.09 },
      { currency: 'VES', items: 1, gross: 3600, discount: 360 },
    ]);
  });

  it('test 16: corregir la tasa manual del día o registrar otra al día siguiente no cambia el informe', async () => {
    const usd = await plan('USD');
    await inTenant(() => add.execute(usd, { ...CROWN(), price: 4 }, ADMIN()));
    const before = await reportFor([usd]);
    // Corrección de la tasa del día (ningún abono la usa: se puede).
    await raw.manualExchangeRate.updateMany({
      where: { tenantId: s.tenantId, currency: 'VES' },
      data: { rate: new Prisma.Decimal('1000') },
    });
    await manualRate(addCivilDays(SEDE.day, 1), '950');
    expect(await reportFor([usd])).toEqual(before);
    expect(before.rows[0]).toMatchObject({ priceReduction: 0.09 });
  });

  it('test 17: plan VES con el catálogo USD: 3.900 frente a 3.960 sale en el informe y el índice parcial rehecho lo sirve', async () => {
    catalogCurrency = 'USD';
    catalogEntity = { ...catalogEntity, defaultPrice: 4.5 };
    await raw.dentalCatalogItem.update({
      where: { id: s.catalogItemId },
      data: { defaultPrice: 4.5 },
    });
    const ves = await plan('VES');
    // La asistente (0 %) no puede: es una rebaja de 60 Bs.
    await expect(
      inTenant(() =>
        add.execute(ves, { ...CROWN(), price: 3900 }, ASSISTANT()),
      ),
    ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
    const item = await inTenant(() =>
      add.execute(ves, { ...CROWN(), price: 3900 }, ADMIN()),
    );
    expect(item).toMatchObject({
      catalogPrice: 4.5,
      referenceCurrency: 'USD',
      referencePriceInPlan: 3960,
    });
    const { rows } = await reportFor([ves]);
    expect(rows).toEqual([
      expect.objectContaining({
        currency: 'VES',
        catalogPrice: 4.5,
        referenceCurrency: 'USD',
        priceReduction: 60,
      }),
    ]);
    // Con el predicado anterior (sin la referencia convertida) no estaría.
    const [{ old }] = await raw.$queryRaw<{ old: bigint }[]>`
      SELECT count(*) AS old FROM "treatment_plan_items"
       WHERE "id" = ${item.id}::uuid
         AND ("discount" > 0 OR "price" < "catalogPrice") AND "deletedAt" IS NULL`;
    expect(old).toBe(0n);
    // L4: el WHERE del informe (las cuatro ramas, el plan vivo y no anulado y
    // el periodo), que es lo que tiene que servir el índice. Se fija que la
    // consulta real siga teniendo estas ramas, para que un cambio del WHERE no
    // pierda el índice sin que este test lo note.
    const repoSource = readFileSync(
      join(
        __dirname,
        '../src/modules/discounts/infrastructure/prisma-discount-report.repository.ts',
      ),
      'utf8',
    );
    for (const arm of [
      'AND (i."discount" > 0 OR i."price" < i."catalogPrice"',
      'OR i."price" < i."referencePriceInPlan"',
      // DX-513-ter: la rama de convenio, con sus dos ramas nuevas (la cubre
      // su propio test en discount-agreement-cross-currency.int-spec.ts).
      'OR (i."agreementId" IS NOT NULL\n                    AND (i."basePrice" > i."catalogPrice"',
      'AND i."deletedAt" IS NULL',
      'AND COALESCE(i."discountAt", i."createdAt") >= ${minStart}',
    ]) {
      expect(repoSource).toContain(arm);
    }
    // Volumen para que el plan sea el de verdad: 3.000 ítems sin descuento
    // del mismo plan (fuera del predicado parcial) y estadísticas al día.
    await raw.$executeRaw`
      INSERT INTO "treatment_plan_items"
        ("id", "tenantId", "planId", "toothNumber", "surfaces", "catalogItemId",
         "catalogPrice", "price", "discount", "updatedAt")
      SELECT gen_random_uuid(), ${s.tenantId}::uuid, ${ves}::uuid, '18', '{}',
             ${s.catalogItemId}::uuid, 100, 100, 0, now()
        FROM generate_series(1, 3000)`;
    await raw.$executeRawUnsafe('ANALYZE "treatment_plan_items"');
    const from = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const to = new Date(Date.now() + 24 * 3600 * 1000);
    const explain = await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<{ 'QUERY PLAN': string }[]>`
        EXPLAIN SELECT i."id"
          FROM "treatment_plan_items" i
          JOIN "treatment_plans" p
            ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
         WHERE i."tenantId" = ${s.tenantId}::uuid
           AND (i."discount" > 0 OR i."price" < i."catalogPrice"
                OR i."price" < i."referencePriceInPlan"
                OR (i."agreementId" IS NOT NULL
                    AND (i."basePrice" > i."catalogPrice"
                         OR i."basePriceInPlan" > i."referencePriceInPlan"
                         OR (i."basePriceInPlan" IS NULL AND i."basePrice" IS NOT NULL
                             AND i."catalogCurrency" IS NOT NULL
                             AND i."referenceCurrency" IS DISTINCT FROM i."catalogCurrency"))))
           AND i."deletedAt" IS NULL
           AND p."deletedAt" IS NULL
           AND p."status" NOT IN ('REJECTED', 'CANCELLED')
           AND COALESCE(i."discountAt", i."createdAt") >= ${from}
           AND COALESCE(i."discountAt", i."createdAt") < ${to}`;
    });
    const planText = explain.map((r) => r['QUERY PLAN']).join('\n');
    // Las tres primeras ramas, por el índice rehecho; la de convenio, por el
    // suyo (SEC-047, rehecho en DX-513-ter).
    expect(planText).toContain(
      'treatment_plan_items_tenant_effective_ref_discount_at_idx',
    );
    expect(planText).toContain(
      'treatment_plan_items_tenant_agreement_ref_reduction_at_idx',
    );
    expect(planText).not.toMatch(/Seq Scan on treatment_plan_items/);
  });

  it('test 18: ningún importe guardado de los ítems anteriores cambia (md5)', async () => {
    const usd = await plan('USD');
    await legacyItem(usd, { price: 80, catalogCurrency: 'VES' });
    await legacyItem(usd, { price: 3600, discount: 5, catalogCurrency: null });
    const before = await LEGACY_SIG(s.tenantId);
    await inTenant(() => add.execute(usd, { ...CROWN(), price: 4 }, ADMIN()));
    await reportFor([usd]);
    expect(await LEGACY_SIG(s.tenantId)).toEqual(before);
    const legacy = await raw.treatmentPlanItem.findMany({
      where: { tenantId: s.tenantId, referencePriceInPlan: null },
      select: { referenceCurrency: true, referenceRateFrom: true },
    });
    expect(legacy).toEqual([
      { referenceCurrency: null, referenceRateFrom: null },
      { referenceCurrency: null, referenceRateFrom: null },
    ]);
  });

  it('test 19: la foto escrita no cambia (restrict_violation); un ítem anterior pasa de NULL a un valor una vez', async () => {
    const usd = await plan('USD');
    const item = await inTenant(() =>
      add.execute(usd, { ...CROWN(), price: 4.09 }, ADMIN()),
    );
    await expect(
      inTenant(() =>
        prisma.runWithTenant((tx) =>
          tx.treatmentPlanItem.update({
            where: { id: item.id },
            data: { referencePriceInPlan: 3 },
          }),
        ),
      ),
    ).rejects.toThrow(/queda fijada al escribirla/);
    await expect(
      raw.treatmentPlanItem.update({
        where: { id: item.id },
        data: { referenceRateFrom: null, referenceRateTo: null },
      }),
    ).rejects.toThrow(/queda fijada|reference_rate_check/);

    // El anterior: primera bajada por la API, la foto se escribe (NULL → valor).
    const legacy = await legacyItem(usd, {
      price: 4.09,
      catalogCurrency: 'VES',
    });
    const updated = await inTenant(() =>
      update.execute(legacy.id, { price: 4 }, ADMIN()),
    );
    expect(updated).toMatchObject({
      referencePriceInPlan: 4.09,
      referenceRate: { fromPerBase: 880, rateDate: SEDE.day },
    });
    await expect(
      raw.treatmentPlanItem.update({
        where: { id: legacy.id },
        data: { referencePriceInPlan: 5 },
      }),
    ).rejects.toThrow(/queda fijada/);
  });

  it('sin tasa (plazo 0 y ninguna registrada hoy): 422 con su código y nada se escribe', async () => {
    await raw.manualExchangeRate.deleteMany({
      where: { tenantId: s.tenantId },
    });
    await raw.tenant.update({
      where: { id: s.tenantId },
      data: { manualRateMaxAgeDays: 0 },
    });
    const usd = await plan('USD');
    await expect(
      inTenant(() => add.execute(usd, { ...CROWN(), price: 4 }, ADMIN())),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: DISCOUNT_REFERENCE_RATE_MISSING_CODE, currency: 'VES' },
    });
    expect(await raw.treatmentPlanItem.count({ where: { planId: usd } })).toBe(
      0,
    );
  });

  it('test 20: la alternativa copia la foto y su clasificación en el informe es la misma', async () => {
    const usd = await plan('USD');
    await inTenant(() => add.execute(usd, { ...CROWN(), price: 4 }, ADMIN()));
    const alternative = await inTenant(() =>
      options.createAlternative(usd, () => ({
        sourceLabel: 'Opción A',
        label: 'Opción B',
        createdById: s.userId,
      })),
    );
    const columns = {
      price: true,
      catalogPrice: true,
      referenceCurrency: true,
      referencePriceInPlan: true,
      basePriceInPlan: true,
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
    const { rows } = await reportFor([usd, alternative!.id]);
    expect(rows.map((r) => [r.priceReduction, r.referencePriceInPlan])).toEqual(
      [
        [0.09, 4.09],
        [0.09, 4.09],
      ],
    );
  });

  it('test 14 (Postgres): un plan con ítems con referencia no cambia de moneda', async () => {
    const usd = await plan('USD');
    await inTenant(() =>
      add.execute(usd, { ...CROWN(), price: 4.09 }, ADMIN()),
    );
    await expect(
      inTenant(() => updatePlan.execute(usd, { currency: 'VES' }, ADMIN())),
    ).rejects.toMatchObject({
      response: { code: CURRENCY_LOCKED_BY_PRICED_ITEMS_CODE },
    });
    expect(
      await raw.treatmentPlan.findUniqueOrThrow({
        where: { id: usd },
        select: { currency: true },
      }),
    ).toEqual({ currency: 'USD' });
  });

  it('test 21: alta y cambio de moneda a la vez: o el 409 o el ítem con la foto de su moneda; nunca una foto en otra moneda', async () => {
    for (let round = 0; round < 4; round += 1) {
      const usd = await plan('USD');
      const [added, changed] = await Promise.allSettled([
        inTenant(() => add.execute(usd, { ...CROWN(), price: 4.09 }, ADMIN())),
        inTenant(() => updatePlan.execute(usd, { currency: 'VES' }, ADMIN())),
      ]);
      const planRow = await raw.treatmentPlan.findUniqueOrThrow({
        where: { id: usd },
        select: { currency: true },
      });
      const items = await raw.treatmentPlanItem.findMany({
        where: { planId: usd, deletedAt: null },
        select: { referenceRateTo: true, referencePriceInPlan: true },
      });
      // Exactamente uno gana; el otro responde 409.
      expect(
        [added, changed].filter((r) => r.status === 'fulfilled'),
      ).toHaveLength(1);
      const loser = [added, changed].find((r) => r.status === 'rejected');
      expect(loser?.reason).toBeInstanceOf(ConflictException);
      if (added.status === 'fulfilled') {
        expect(planRow.currency).toBe('USD');
        expect(items).toEqual([
          {
            referenceRateTo: new Prisma.Decimal(1),
            referencePriceInPlan: new Prisma.Decimal('4.09'),
          },
        ]);
      } else {
        expect(planRow.currency).toBe('VES');
        expect(items).toEqual([]);
      }
    }
  });
});
