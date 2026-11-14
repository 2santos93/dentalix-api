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
import { PrismaPricingSource } from '../src/modules/treatment-plans/infrastructure/pricing/prisma-pricing-source';
import { AddTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/add-treatment-plan-item.use-case';
import { UpdateTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan-item.use-case';
import { testDiscountPolicy } from '../src/modules/treatment-plans/application/use-cases/__fixtures__/discount-fixtures';
import { PrismaDentalCatalogRepository } from '../src/modules/dental-catalog/infrastructure/repositories/prisma-dental-catalog.repository';
import { PrismaPriceListRepository } from '../src/modules/price-lists/infrastructure/repositories/prisma-price-list.repository';
import { PrismaAgreementRepository } from '../src/modules/agreements/infrastructure/repositories/prisma-agreement.repository';
import { PrismaPatientAgreementRepository } from '../src/modules/patient-agreements/infrastructure/repositories/prisma-patient-agreement.repository';
import { PrismaDiscountReportRepository } from '../src/modules/discounts/infrastructure/prisma-discount-report.repository';
import {
  priceBelowCatalogCapMessage,
  priceBelowCatalogReasonMessage,
} from '../src/modules/discounts/domain/effective-discount';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  REGIONAL_NEW_YORK_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { civilDaysSince } from './support/sede-clock';
import type { ReferenceRateSource } from '../src/modules/treatment-plans/domain/ports/reference-rate-source.port';

// DX-502-bis contra Postgres, con la fuente de precios REAL: la moneda del
// catálogo fijada por la clínica (`tenants.catalogCurrency`) es la que se
// congela en los ítems nuevos; sin ella, la común de las sedes activas o
// NULL (DX-502). Lo ya congelado no cambia al fijarla, cambiarla ni quitarla.
// Con ella, una clínica con sedes en USD y VES vuelve a tener la moneda del
// catálogo conocida, y la regla de descuentos de DX-513 se aplica sola: un
// plan en USD por debajo del catálogo (USD) es un descuento (tope y motivo) y
// sale en el informe. `raw` (DIRECT_URL, owner) siembra y comprueba.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const plans = new PrismaTreatmentPlanRepository(prisma, tenantContext);
const catalogRepo = new PrismaDentalCatalogRepository(prisma, tenantContext);
const pricing = new PrismaPricingSource(
  prisma,
  tenantContext,
  catalogRepo,
  new PrismaPriceListRepository(prisma, tenantContext),
  new PrismaAgreementRepository(prisma, tenantContext),
  new PrismaPatientAgreementRepository(prisma, tenantContext),
  () => new Date(),
  new PrismaCurrencyDigitsCatalog(prisma),
);
const policy = testDiscountPolicy();
const now = () => new Date();
/**
 * DX-513-bis: la tasa de hoy (unidades por 1 USD; USD vale 1). A la par por
 * defecto, para que los importes de estos casos (DX-502-bis) no cambien.
 */
const ratesAt = (ves: number, eur = 1): ReferenceRateSource => ({
  rateFor: (from, to) => {
    const of = (c: string) => (c === 'VES' ? ves : c === 'EUR' ? eur : 1);
    return Promise.resolve({
      kind: 'rate',
      rate: {
        fromPerBase: of(from),
        toPerBase: of(to),
        source: 'MANUAL',
        rateDate: '2026-11-07',
      },
      toDigits: 2,
    });
  },
});
const add = new AddTreatmentPlanItemUseCase(
  plans,
  pricing,
  policy,
  now,
  ratesAt(1),
);
const update = new UpdateTreatmentPlanItemUseCase(
  plans,
  catalogRepo,
  policy,
  now,
  ratesAt(1),
);
const report = new PrismaDiscountReportRepository(prisma, tenantContext);

interface Seeded {
  tenantId: string;
  userId: string;
  patientId: string;
  catalogItemId: string;
  usdLocationId: string;
}
let s: Seeded;

const ADMIN = () => ({ userId: s.userId, role: ClinicRole.ADMIN });
const ASSISTANT = () => ({ userId: s.userId, role: ClinicRole.ASSISTANT });
const CROWN = () => ({ toothNumber: '11', catalogItemId: s.catalogItemId });

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(s.tenantId, fn);
}

async function plan(currency: 'USD' | 'VES'): Promise<string> {
  const created = await raw.treatmentPlan.create({
    data: { tenantId: s.tenantId, patientId: s.patientId, currency },
  });
  return created.id;
}

async function setCatalogCurrency(code: string | null): Promise<void> {
  await raw.tenant.update({
    where: { id: s.tenantId },
    data: { catalogCurrency: code },
  });
}

function period(): { from: string; to: string } {
  const days = civilDaysSince(24 * 60, REGIONAL_NEW_YORK_FIXTURE.timeZone);
  return { from: days[0], to: addCivilDays(days[days.length - 1], 1) };
}

/**
 * Una clínica con una sede en USD (Nueva York, la primera: la de escritura) y
 * otra en VES (Caracas).
 */
async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const user = await raw.user.create({
    data: {
      email: `${subdomain}@int.test`,
      passwordHash: 'x',
      fullName: 'Dra. Catálogo',
    },
  });
  const usd = await raw.location.create({
    data: locationData(REGIONAL_NEW_YORK_FIXTURE, {
      tenantId: tenant.id,
      name: `Sede USD ${subdomain}`,
    }),
  });
  await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: `Sede Caracas ${subdomain}`,
    }),
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: 'Catálogo' },
  });
  const item = await raw.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: `${subdomain}-crown`,
      kind: 'PROCEDURE',
      labelEs: 'Corona',
      color: '#123456',
      defaultPrice: 100,
    },
  });
  return {
    tenantId: tenant.id,
    userId: user.id,
    patientId: patient.id,
    catalogItemId: item.id,
    usdLocationId: usd.id,
  };
}

describe('moneda del catálogo fijada por la clínica (DX-502-bis, Postgres)', () => {
  let seq = 0;
  beforeAll(async () => {
    await resetDatabase(raw);
  });

  // Una clínica por test: los totales del informe son de toda la clínica.
  beforeEach(async () => {
    s = await seedClinic(`dx502b-int-${++seq}`);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  it('sin moneda fijada y con sedes en USD y VES, todo igual que hoy: el ítem nuevo queda sin moneda del catálogo', async () => {
    const planId = await plan('USD');
    const created = await inTenant(() =>
      add.execute(planId, { ...CROWN(), price: 100 }, ADMIN()),
    );
    expect(created).toMatchObject({ basePrice: 100, catalogCurrency: null });
  });

  it('con la moneda fijada en USD, el ítem nuevo la congela aunque las sedes no compartan moneda', async () => {
    await setCatalogCurrency('USD');
    const usd = await plan('USD');
    const ves = await plan('VES');
    expect(
      await inTenant(() =>
        add.execute(usd, { ...CROWN(), price: 100 }, ADMIN()),
      ),
    ).toMatchObject({ basePrice: 100, catalogCurrency: 'USD' });
    // La moneda del plan no la decide: es la del catálogo de la clínica.
    expect(
      await inTenant(() =>
        add.execute(ves, { ...CROWN(), price: 100 }, ADMIN()),
      ),
    ).toMatchObject({ catalogCurrency: 'USD' });
  });

  it('la moneda fijada manda también sobre una moneda común de las sedes', async () => {
    // Solo la sede en USD activa: la común sería USD.
    await raw.location.updateMany({
      where: { tenantId: s.tenantId, currency: 'VES' },
      data: { isActive: false },
    });
    const planId = await plan('USD');
    expect(
      await inTenant(() =>
        add.execute(planId, { ...CROWN(), price: 100 }, ADMIN()),
      ),
    ).toMatchObject({ catalogCurrency: 'USD' });
    await setCatalogCurrency('VES');
    expect(
      await inTenant(() =>
        add.execute(planId, { ...CROWN(), price: 100 }, ADMIN()),
      ),
    ).toMatchObject({ catalogCurrency: 'VES' });
  });

  it('lo congelado no cambia al fijar, cambiar o quitar la moneda de la clínica, ni cambia ningún importe', async () => {
    const planId = await plan('USD');
    const before = await inTenant(() =>
      add.execute(planId, { ...CROWN(), price: 100 }, ADMIN()),
    );
    await setCatalogCurrency('USD');
    const withUsd = await inTenant(() =>
      add.execute(planId, { ...CROWN(), price: 100 }, ADMIN()),
    );
    await setCatalogCurrency('VES');
    const withVes = await inTenant(() =>
      add.execute(planId, { ...CROWN(), price: 100 }, ADMIN()),
    );
    await setCatalogCurrency(null);
    const after = await inTenant(() =>
      add.execute(planId, { ...CROWN(), price: 100 }, ADMIN()),
    );

    const stored = await raw.treatmentPlanItem.findMany({
      where: { planId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        price: true,
        basePrice: true,
        catalogPrice: true,
        catalogCurrency: true,
      },
    });
    expect(stored.map((i) => [i.id, i.catalogCurrency])).toEqual([
      [before.id, null],
      [withUsd.id, 'USD'],
      [withVes.id, 'VES'],
      [after.id, null],
    ]);
    for (const item of stored) {
      expect(Number(item.price)).toBe(100);
      expect(Number(item.basePrice)).toBe(100);
    }
  });

  it('DX-513: clínica multimoneda con el catálogo en USD y plan en USD por debajo del catálogo: es un descuento (tope, motivo e informe)', async () => {
    await setCatalogCurrency('USD');
    const planId = await plan('USD');
    // La asistente (tope 0 %) no puede bajar de 100 a 80 USD.
    await expect(
      inTenant(() =>
        add.execute(planId, { ...CROWN(), price: 80 }, ASSISTANT()),
      ),
    ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
    // El ADMIN sí, pero un 20 % pide motivo.
    await expect(
      inTenant(() => add.execute(planId, { ...CROWN(), price: 80 }, ADMIN())),
    ).rejects.toThrow(
      new UnprocessableEntityException(priceBelowCatalogReasonMessage(10)),
    );
    const created = await inTenant(() =>
      add.execute(
        planId,
        { ...CROWN(), price: 80, discountReason: 'LOYALTY' },
        ADMIN(),
      ),
    );
    expect(created).toMatchObject({
      price: 80,
      catalogPrice: 100,
      catalogCurrency: 'USD',
      discountReason: 'LOYALTY',
      discountById: s.userId,
    });
    // Editar: la asistente tampoco puede bajarlo más.
    await expect(
      inTenant(() => update.execute(created.id, { price: 70 }, ASSISTANT())),
    ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));

    const q = period();
    const [rows, summary] = await inTenant(() =>
      Promise.all([report.rows(q), report.summary(q)]),
    );
    expect(rows.filter((r) => r.planId === planId)).toEqual([
      expect.objectContaining({
        currency: 'USD',
        catalogPrice: 100,
        price: 80,
        priceReduction: 20,
        discount: 20,
        reason: 'LOYALTY',
      }),
    ]);
    expect(summary.totals).toEqual([
      { currency: 'USD', items: 1, gross: 100, discount: 20 },
    ]);
  });

  it('DX-513-bis: con el catálogo en USD (100) y un plan en VES a 400 Bs./USD, la referencia es 40.000 Bs. y 32.000 es una rebaja', async () => {
    await setCatalogCurrency('USD');
    const planId = await plan('VES');
    const addAt400 = new AddTreatmentPlanItemUseCase(
      plans,
      pricing,
      policy,
      now,
      ratesAt(400),
    );
    await expect(
      inTenant(() =>
        addAt400.execute(planId, { ...CROWN(), price: 32000 }, ASSISTANT()),
      ),
    ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
    const created = await inTenant(() =>
      addAt400.execute(planId, CROWN(), ASSISTANT()),
    );
    expect(created).toMatchObject({
      catalogCurrency: 'USD',
      catalogPrice: 100,
      referenceCurrency: 'USD',
      referencePriceInPlan: 40000,
      price: 40000,
      referenceRate: { fromPerBase: 1, toPerBase: 400 },
      discountById: null,
    });
  });
});
