import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  AgreementKind,
  CatalogKind,
  PriceSource,
  TreatmentPlanStatus,
} from '@prisma/client';
import {
  ADMIN_ACTOR,
  DENTIST_ACTOR,
  FIXED_CLOCK,
  testDiscountPolicy,
} from './__fixtures__/discount-fixtures';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';
import {
  catalogPricing,
  PRICING_LOCATION_ID,
} from './__fixtures__/catalog-pricing-source';
import { AddTreatmentPlanItemUseCase } from './add-treatment-plan-item.use-case';
import { UpdateTreatmentPlanItemUseCase } from './update-treatment-plan-item.use-case';
import { ApplyBulkDiscountUseCase } from './apply-bulk-discount.use-case';
import { GetPriceQuoteUseCase } from './get-price-quote.use-case';
import {
  NO_DISCOUNT_ALLOWED_MESSAGE,
  type PricingAgreement,
  type PricingContext,
} from '../../domain/pricing/resolve-item-price';
import type { PricingSource } from '../../domain/ports/pricing-source.port';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogItem } from '../../../dental-catalog/domain/entities/dental-catalog-item.entity';

// DX-105: el alta resuelve el precio (convenio → lista de la sede → catálogo),
// lo deja como referencia (`catalogPrice`, R1) con su foto, y las prestaciones
// sin descuentos no admiten rebajas en alta, edición ni «Descuento %».

function catalogItem(
  id: string,
  overrides: Partial<DentalCatalogItem> = {},
): DentalCatalogItem {
  return {
    id,
    tenantId: 't1',
    code: id.toUpperCase(),
    category: 'Endodoncia',
    kind: CatalogKind.PROCEDURE,
    labelEs: id,
    labelEn: null,
    labelPt: null,
    color: '#FFFFFF',
    defaultPrice: 100_000,
    allowDiscount: true,
    active: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const ENDO = catalogItem('endo');
const XRAY = catalogItem('xray', { allowDiscount: false, category: null });
const ITEMS = [ENDO, XRAY];

const catalog = {
  findById: (id: string) =>
    Promise.resolve(ITEMS.find((c) => c.id === id) ?? null),
  findByIds: (ids: string[]) =>
    Promise.resolve(ITEMS.filter((c) => ids.includes(c.id))),
} as unknown as DentalCatalogRepository;

const SURCO: PricingAgreement = {
  id: 'agr-surco',
  name: 'Surco Salud',
  kind: AgreementKind.PERCENT_DISCOUNT,
  percent: 15,
  percentByCategory: null,
  priceListId: null,
  locationId: null,
  active: true,
  validFrom: null,
  validTo: null,
  assignmentValidFrom: null,
  assignmentValidTo: null,
};

function setup(
  extra: Partial<Omit<PricingContext, 'catalogItem' | 'planCurrency'>> = {},
) {
  const repo = new InMemoryTreatmentPlanRepository();
  repo.seedPlan({
    id: 'plan1',
    patientId: 'p1',
    currency: 'COP',
    status: TreatmentPlanStatus.DRAFT,
  });
  const pricing = catalogPricing(catalog, extra);
  const policy = testDiscountPolicy();
  return {
    repo,
    pricing,
    add: new AddTreatmentPlanItemUseCase(repo, pricing, policy, FIXED_CLOCK),
    update: new UpdateTreatmentPlanItemUseCase(
      repo,
      catalog,
      policy,
      FIXED_CLOCK,
    ),
    bulk: new ApplyBulkDiscountUseCase(repo, policy, FIXED_CLOCK, catalog),
  };
}

describe('Precio resuelto y foto en el alta del ítem (DX-105)', () => {
  it('resuelve con el paciente y la moneda del plan, y sella la foto', async () => {
    const { add, pricing } = setup({ agreement: SURCO });
    const item = await add.execute(
      'plan1',
      { toothNumber: '11', catalogItemId: 'endo' },
      ADMIN_ACTOR,
    );
    expect(pricing.calls).toEqual([{ patientId: 'p1', currency: 'COP' }]);
    expect(item).toMatchObject({
      price: 85_000,
      catalogPrice: 85_000,
      discount: 0,
      basePrice: 100_000,
      priceSource: PriceSource.AGREEMENT_PERCENT,
      agreementId: 'agr-surco',
      agreementName: 'Surco Salud',
      pricingLocationId: PRICING_LOCATION_ID,
      // El precio de convenio no es un descuento discrecional (R1).
      discountById: null,
      discountReason: null,
    });
  });

  it('sin convenio ni lista: foto CATALOG con la referencia = defaultPrice', async () => {
    const { add } = setup();
    const item = await add.execute(
      'plan1',
      { toothNumber: '11', catalogItemId: 'endo' },
      ADMIN_ACTOR,
    );
    expect(item).toMatchObject({
      price: 100_000,
      catalogPrice: 100_000,
      basePrice: 100_000,
      priceSource: PriceSource.CATALOG,
      agreementId: null,
      agreementName: null,
    });
  });

  it('precio explícito por debajo de la referencia: la política lo juzga contra el precio pactado', async () => {
    const { add } = setup({ agreement: SURCO });
    // 85 000 → 80 000 es un 5,9 %: dentro del 10 % del DENTIST.
    const item = await add.execute(
      'plan1',
      { toothNumber: '11', catalogItemId: 'endo', price: 80_000 },
      DENTIST_ACTOR,
    );
    expect(item).toMatchObject({
      price: 80_000,
      catalogPrice: 85_000,
      discountById: DENTIST_ACTOR.userId,
    });
    // 85 000 → 70 000 (17,6 %) ya pasa el tope del DENTIST: 403.
    await expect(
      add.execute(
        'plan1',
        { toothNumber: '11', catalogItemId: 'endo', price: 70_000 },
        DENTIST_ACTOR,
      ),
    ).rejects.toThrow('10 %');
  });

  it('procedimiento inexistente: 404', async () => {
    const { add } = setup();
    await expect(
      add.execute(
        'plan1',
        { toothNumber: '11', catalogItemId: 'nope' },
        ADMIN_ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('la moneda del plan cambió entre la resolución y el alta: 409 y nada se escribe', async () => {
    const { repo } = setup();
    const raced: PricingSource = {
      async contextFor(patientId, catalogItemId, currency) {
        const ctx = await catalogPricing(catalog).contextFor(
          patientId,
          catalogItemId,
          currency,
        );
        // Otra petición cambia la moneda mientras se resolvía el precio.
        await repo.updatePlan('plan1', () => ({ currency: 'USD' }));
        return ctx;
      },
    };
    const add = new AddTreatmentPlanItemUseCase(
      repo,
      raced,
      testDiscountPolicy(),
      FIXED_CLOCK,
    );
    await expect(
      add.execute(
        'plan1',
        { toothNumber: '11', catalogItemId: 'endo' },
        ADMIN_ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await repo.findPlanById('plan1'))!.items).toHaveLength(0);
  });

  describe('prestación sin descuentos (allowDiscount=false)', () => {
    it('alta con descuento: 400 en español y no se crea', async () => {
      const { add, repo } = setup();
      await expect(
        add.execute(
          'plan1',
          { toothNumber: '11', catalogItemId: 'xray', discount: 1 },
          ADMIN_ACTOR,
        ),
      ).rejects.toThrow(new BadRequestException(NO_DISCOUNT_ALLOWED_MESSAGE));
      expect((await repo.findPlanById('plan1'))!.items).toHaveLength(0);
    });

    it('alta con precio por debajo de la referencia: 400', async () => {
      const { add } = setup();
      await expect(
        add.execute(
          'plan1',
          { toothNumber: '11', catalogItemId: 'xray', price: 99_999 },
          ADMIN_ACTOR,
        ),
      ).rejects.toThrow(NO_DISCOUNT_ALLOWED_MESSAGE);
    });

    it('alta al precio de referencia o por encima: se crea', async () => {
      const { add } = setup();
      const item = await add.execute(
        'plan1',
        { toothNumber: '11', catalogItemId: 'xray', price: 120_000 },
        ADMIN_ACTOR,
      );
      expect(item).toMatchObject({ price: 120_000, catalogPrice: 100_000 });
    });

    it('con convenio %: el convenio no aplica, sale el precio de catálogo', async () => {
      const { add } = setup({ agreement: SURCO });
      const item = await add.execute(
        'plan1',
        { toothNumber: '11', catalogItemId: 'xray' },
        ADMIN_ACTOR,
      );
      expect(item).toMatchObject({
        price: 100_000,
        catalogPrice: 100_000,
        priceSource: PriceSource.CATALOG,
        agreementId: null,
      });
    });

    it('con convenio de lista: el precio pactado sí aplica (no es un descuento)', async () => {
      const { add } = setup({
        agreement: {
          ...SURCO,
          kind: AgreementKind.PRICE_LIST,
          percent: null,
          priceListId: 'list-1',
        },
        agreementListPrice: { price: 60_000, currency: 'COP', active: true },
      });
      const item = await add.execute(
        'plan1',
        { toothNumber: '11', catalogItemId: 'xray' },
        ADMIN_ACTOR,
      );
      expect(item).toMatchObject({
        price: 60_000,
        catalogPrice: 60_000,
        basePrice: 100_000,
        priceSource: PriceSource.AGREEMENT_PRICE_LIST,
        discountById: null,
      });
    });

    it('edición: dar un descuento o rebajar el precio, 400; nada cambia', async () => {
      const { update, repo } = setup();
      repo.seedItem({
        id: 'item1',
        planId: 'plan1',
        catalogItemId: 'xray',
        catalogPrice: 100_000,
        price: 100_000,
      });
      await expect(
        update.execute('item1', { discount: 5_000 }, ADMIN_ACTOR),
      ).rejects.toThrow(NO_DISCOUNT_ALLOWED_MESSAGE);
      await expect(
        update.execute('item1', { price: 90_000 }, ADMIN_ACTOR),
      ).rejects.toThrow(NO_DISCOUNT_ALLOWED_MESSAGE);
      expect(await repo.findItemById('item1')).toMatchObject({
        price: 100_000,
        discount: 0,
      });
      // Subir el precio o tocar otra cosa sí se puede.
      await expect(
        update.execute('item1', { price: 110_000 }, ADMIN_ACTOR),
      ).resolves.toMatchObject({ price: 110_000 });
    });

    it('edición: un descuento anterior a la marca se puede bajar o quitar, no subir', async () => {
      const { update, repo } = setup();
      repo.seedItem({
        id: 'item1',
        planId: 'plan1',
        catalogItemId: 'xray',
        catalogPrice: 100_000,
        price: 100_000,
        discount: 10_000,
      });
      await expect(
        update.execute('item1', { discount: 12_000 }, ADMIN_ACTOR),
      ).rejects.toThrow(NO_DISCOUNT_ALLOWED_MESSAGE);
      await expect(
        update.execute('item1', { discount: 0 }, ADMIN_ACTOR),
      ).resolves.toMatchObject({ discount: 0 });
    });

    it('«Descuento %»: se salta y la respuesta dice cuántos', async () => {
      const { bulk, repo } = setup();
      repo.seedItem({
        id: 'a',
        planId: 'plan1',
        catalogItemId: 'endo',
        price: 1000,
      });
      repo.seedItem({
        id: 'b',
        planId: 'plan1',
        catalogItemId: 'xray',
        price: 1000,
      });
      const result = await bulk.execute(
        'plan1',
        { itemIds: ['a', 'b'], percent: 5 },
        ADMIN_ACTOR,
      );
      expect(result.skippedNoDiscount).toBe(1);
      expect(result.items.map((i) => [i.id, i.discount])).toEqual([['a', 50]]);
      expect((await repo.findItemById('b'))!.discount).toBe(0);
    });

    it('alta en un plan cerrado con descuento en una prestación sin descuentos: 409 antes que 400', async () => {
      const { add, repo } = setup();
      repo.seedPlan({
        id: 'plan-closed',
        patientId: 'p1',
        currency: 'COP',
        status: TreatmentPlanStatus.CANCELLED,
      });
      await expect(
        add.execute(
          'plan-closed',
          { toothNumber: '11', catalogItemId: 'xray', discount: 1 },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('edición con el procedimiento fuera del catálogo: cierra por defecto (400)', async () => {
      const { update, repo } = setup();
      repo.seedItem({
        id: 'orphan',
        planId: 'plan1',
        catalogItemId: 'retired',
        catalogPrice: 100_000,
        price: 100_000,
      });
      await expect(
        update.execute('orphan', { discount: 5_000 }, ADMIN_ACTOR),
      ).rejects.toThrow(NO_DISCOUNT_ALLOWED_MESSAGE);
      expect((await repo.findItemById('orphan'))!.discount).toBe(0);
    });

    it('«Descuento %» al 0 % no salta la prestación sin descuentos: limpia el anterior', async () => {
      const { bulk, repo } = setup();
      repo.seedItem({
        id: 'b',
        planId: 'plan1',
        catalogItemId: 'xray',
        price: 1000,
        discount: 100,
      });
      const result = await bulk.execute(
        'plan1',
        { itemIds: ['b'], percent: 0 },
        ADMIN_ACTOR,
      );
      expect(result.skippedNoDiscount).toBe(0);
      expect(result.items.map((i) => [i.id, i.discount])).toEqual([['b', 0]]);
      expect((await repo.findItemById('b'))!.discount).toBe(0);
    });

    it('«Descuento %» con todos saltados: nada cambia y no falla', async () => {
      const { bulk, repo } = setup();
      repo.seedItem({
        id: 'b',
        planId: 'plan1',
        catalogItemId: 'xray',
        price: 1000,
      });
      const result = await bulk.execute(
        'plan1',
        { itemIds: ['b'], percent: 5 },
        ADMIN_ACTOR,
      );
      expect(result).toEqual({ items: [], skippedNoDiscount: 1 });
      expect((await repo.findItemById('b'))!.discount).toBe(0);
    });
  });
});

describe('GetPriceQuoteUseCase (DX-105)', () => {
  const patients = (exists: boolean) => ({
    patientExists: () => Promise.resolve(exists),
  });

  it('devuelve la misma resolución que el alta, con la moneda pedida', async () => {
    const quote = new GetPriceQuoteUseCase(
      catalogPricing(catalog, { agreement: SURCO }),
      patients(true),
    );
    await expect(quote.execute('p1', 'endo', 'COP')).resolves.toEqual({
      basePrice: 100_000,
      price: 85_000,
      source: PriceSource.AGREEMENT_PERCENT,
      agreementId: 'agr-surco',
      agreementName: 'Surco Salud',
      allowDiscount: true,
      currency: 'COP',
    });
  });

  it('paciente de otra clínica o inexistente: 404 en español', async () => {
    const quote = new GetPriceQuoteUseCase(
      catalogPricing(catalog),
      patients(false),
    );
    await expect(quote.execute('p1', 'endo', 'COP')).rejects.toThrow(
      new NotFoundException('Paciente no encontrado.'),
    );
  });

  it('procedimiento inexistente: 404', async () => {
    const quote = new GetPriceQuoteUseCase(
      catalogPricing(catalog),
      patients(true),
    );
    await expect(quote.execute('p1', 'nope', 'COP')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
