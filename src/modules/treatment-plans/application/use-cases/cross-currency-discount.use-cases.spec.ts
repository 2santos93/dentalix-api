import { referenceCurrencyDigitsCatalog } from '../../../../shared/money/__fixtures__/reference-currency-digits';
import {
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CatalogKind, PriceSource, TreatmentPlanStatus } from '@prisma/client';
import {
  ADMIN_ACTOR,
  ASSISTANT_ACTOR,
  FIXED_CLOCK,
  testDiscountPolicy,
} from './__fixtures__/discount-fixtures';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';
import { catalogPricing } from './__fixtures__/catalog-pricing-source';
import { AddTreatmentPlanItemUseCase } from './add-treatment-plan-item.use-case';
import { UpdateTreatmentPlanItemUseCase } from './update-treatment-plan-item.use-case';
import { ApplyBulkDiscountUseCase } from './apply-bulk-discount.use-case';
import {
  priceBelowCatalogCapMessage,
  priceBelowCatalogReasonMessage,
} from '../../../discounts/domain/effective-discount';
import { NO_DISCOUNT_ALLOWED_MESSAGE } from '../../domain/pricing/resolve-item-price';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogItem } from '../../../dental-catalog/domain/entities/dental-catalog-item.entity';
import type { PricingContext } from '../../domain/pricing/resolve-item-price';

// DX-513: el catálogo de la clínica está en VES (3.600,00). Una rebaja frente
// a él en un plan en USD no es un descuento; en un plan en VES, sí (SEC-041),
// y con la moneda del catálogo desconocida (NULL), también: cuenta como hoy.
const CROWN = {
  id: 'crown',
  kind: CatalogKind.PROCEDURE,
  defaultPrice: 3600,
  allowDiscount: true,
} as DentalCatalogItem;
const LOCKED = { ...CROWN, id: 'locked', allowDiscount: false };

const catalog = {
  findById: (id: string) =>
    Promise.resolve([CROWN, LOCKED].find((c) => c.id === id) ?? null),
  findByIds: (ids: string[]) =>
    Promise.resolve(
      ids.map((id) => [CROWN, LOCKED].find((c) => c.id === id) ?? CROWN),
    ),
} as unknown as DentalCatalogRepository;

function setup(
  planCurrency: 'USD' | 'VES',
  pricing: Partial<PricingContext> = {},
) {
  const repo = new InMemoryTreatmentPlanRepository();
  repo.seedPlan({
    id: 'plan1',
    status: TreatmentPlanStatus.DRAFT,
    currency: planCurrency,
  });
  const policy = testDiscountPolicy();
  return {
    repo,
    add: new AddTreatmentPlanItemUseCase(
      repo,
      catalogPricing(catalog, { catalogCurrency: 'VES', ...pricing }),
      policy,
      FIXED_CLOCK,
    ),
    update: new UpdateTreatmentPlanItemUseCase(
      repo,
      catalog,
      policy,
      FIXED_CLOCK,
    ),
    bulk: new ApplyBulkDiscountUseCase(
      repo,
      policy,
      FIXED_CLOCK,
      catalog,
      referenceCurrencyDigitsCatalog(),
    ),
  };
}

const CROWN_ITEM = { toothNumber: '11', catalogItemId: 'crown' };

describe('rebaja frente a un catálogo en otra moneda (DX-513)', () => {
  describe('alta', () => {
    it('plan en USD con el catálogo en VES: 80 USD lo da la asistente (tope 0 %) sin motivo ni firma', async () => {
      const { add } = setup('USD');
      const item = await add.execute(
        'plan1',
        { ...CROWN_ITEM, price: 80 },
        ASSISTANT_ACTOR,
      );
      expect(item).toMatchObject({
        price: 80,
        catalogPrice: 3600,
        catalogCurrency: 'VES',
        discount: 0,
        discountReason: null,
        discountById: null,
        discountAt: null,
      });
    });

    it('plan en VES con el catálogo en VES: igual que hoy (403 de la asistente, 422 sin motivo)', async () => {
      const { add } = setup('VES');
      await expect(
        add.execute('plan1', { ...CROWN_ITEM, price: 3000 }, ASSISTANT_ACTOR),
      ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
      await expect(
        add.execute('plan1', { ...CROWN_ITEM, price: 2880 }, ADMIN_ACTOR),
      ).rejects.toThrow(
        new UnprocessableEntityException(priceBelowCatalogReasonMessage(10)),
      );
    });

    it('catalogCurrency NULL (sedes en monedas distintas): cuenta como hoy (403 de la asistente)', async () => {
      const { add } = setup('USD', { catalogCurrency: null });
      await expect(
        add.execute('plan1', { ...CROWN_ITEM, price: 80 }, ASSISTANT_ACTOR),
      ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
    });

    it('en otra moneda, el descuento propio sigue contando (en la moneda del plan)', async () => {
      const { add } = setup('USD');
      await expect(
        add.execute(
          'plan1',
          { ...CROWN_ITEM, price: 80, discount: 1 },
          ASSISTANT_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lista de la sede en USD con el catálogo en VES: la rebaja frente a la lista sí cuenta (misma moneda)', async () => {
      const { add } = setup('USD', {
        locationList: { price: 100, currency: 'USD' },
      });
      await expect(
        add.execute('plan1', { ...CROWN_ITEM, price: 80 }, ASSISTANT_ACTOR),
      ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
    });

    it('prestación sin descuentos: bajar frente a un catálogo en otra moneda no es descontar', async () => {
      const { add } = setup('USD');
      await expect(
        add.execute(
          'plan1',
          { toothNumber: '11', catalogItemId: 'locked', price: 80 },
          ASSISTANT_ACTOR,
        ),
      ).resolves.toMatchObject({ price: 80 });
      const ves = setup('VES');
      await expect(
        ves.add.execute(
          'plan1',
          { toothNumber: '11', catalogItemId: 'locked', price: 80 },
          ADMIN_ACTOR,
        ),
      ).rejects.toThrow(new BadRequestException(NO_DISCOUNT_ALLOWED_MESSAGE));
    });
  });

  describe('edición', () => {
    function withItem(
      planCurrency: 'USD' | 'VES',
      catalogCurrency: string | null,
      priceSource: PriceSource | null = PriceSource.CATALOG,
    ) {
      const ctx = setup(planCurrency);
      ctx.repo.seedItem({
        id: 'item1',
        planId: 'plan1',
        catalogItemId: 'crown',
        catalogPrice: 3600,
        basePrice: 3600,
        catalogCurrency,
        priceSource,
        price: 3600,
      });
      return ctx;
    }

    it('plan en USD con el catálogo en VES: la asistente baja a 80 sin 403 ni firma', async () => {
      const { update } = withItem('USD', 'VES');
      const item = await update.execute(
        'item1',
        { price: 80 },
        ASSISTANT_ACTOR,
      );
      expect(item).toMatchObject({ price: 80, discountById: null });
    });

    it('plan en VES con el catálogo en VES: igual que hoy (403)', async () => {
      const { update, repo } = withItem('VES', 'VES');
      await expect(
        update.execute('item1', { price: 80 }, ASSISTANT_ACTOR),
      ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
      expect((await repo.findItemById('item1'))!.price).toBe(3600);
    });

    it('catalogCurrency NULL: cuenta como hoy (403)', async () => {
      const { update, repo } = withItem('USD', null);
      await expect(
        update.execute('item1', { price: 80 }, ASSISTANT_ACTOR),
      ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
      expect((await repo.findItemById('item1'))!.price).toBe(3600);
    });

    it('ítem anterior a DX-105 con catalogCurrency NULL: cuenta como hoy (403)', async () => {
      const { update } = withItem('USD', null, null);
      await expect(
        update.execute('item1', { price: 80 }, ASSISTANT_ACTOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('«Descuento %» en bloque', () => {
    it('plan en USD con el catálogo en VES: la rebaja no se suma al %; el ADMIN aplica un 9 % sin motivo', async () => {
      const ctx = setup('USD');
      ctx.repo.seedItem({
        id: 'item1',
        planId: 'plan1',
        catalogItemId: 'crown',
        catalogPrice: 3600,
        catalogCurrency: 'VES',
        priceSource: PriceSource.CATALOG,
        price: 80,
      });
      const {
        items: [item],
      } = await ctx.bulk.execute(
        'plan1',
        { itemIds: ['item1'], percent: 9 },
        ADMIN_ACTOR,
      );
      expect(item).toMatchObject({ discount: 7.2, discountReason: null });
    });

    it('plan en VES con el catálogo en VES: igual que hoy, la rebaja se suma y pide motivo', async () => {
      const ctx = setup('VES');
      ctx.repo.seedItem({
        id: 'item1',
        planId: 'plan1',
        catalogItemId: 'crown',
        catalogPrice: 3600,
        catalogCurrency: 'VES',
        priceSource: PriceSource.CATALOG,
        price: 3240,
        discountReason: null,
      });
      await expect(
        ctx.bulk.execute(
          'plan1',
          { itemIds: ['item1'], percent: 9 },
          ADMIN_ACTOR,
        ),
      ).rejects.toThrow(
        new UnprocessableEntityException(priceBelowCatalogReasonMessage(10)),
      );
    });
  });
});
