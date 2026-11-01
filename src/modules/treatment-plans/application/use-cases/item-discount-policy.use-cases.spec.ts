import { referenceCurrencyDigitsCatalog } from '../../../../shared/money/__fixtures__/reference-currency-digits';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CatalogKind,
  DiscountReason,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import {
  ADMIN_ACTOR,
  ASSISTANT_ACTOR,
  DENTIST_ACTOR,
  DISCOUNT_NOW,
  FIXED_CLOCK,
  testDiscountPolicy,
} from './__fixtures__/discount-fixtures';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';
import { catalogPricing } from './__fixtures__/catalog-pricing-source';
import { AddTreatmentPlanItemUseCase } from './add-treatment-plan-item.use-case';
import { UpdateTreatmentPlanItemUseCase } from './update-treatment-plan-item.use-case';
import { ApplyBulkDiscountUseCase } from './apply-bulk-discount.use-case';
import { ACCEPTED_PLAN_DISCOUNT_LOCKED_MESSAGE } from './item-discount';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogItem } from '../../../dental-catalog/domain/entities/dental-catalog-item.entity';

const CATALOG_ITEM = {
  id: 'cat1',
  kind: CatalogKind.PROCEDURE,
  defaultPrice: 1000,
  allowDiscount: true,
} as DentalCatalogItem;

const catalog = {
  findById: (id: string) =>
    Promise.resolve(
      id === CATALOG_ITEM.id ? CATALOG_ITEM : { ...CATALOG_ITEM, id },
    ),
  // DX-105: el «Descuento %» mira si cada procedimiento admite descuentos.
  findByIds: (ids: string[]) =>
    Promise.resolve(ids.map((id) => ({ ...CATALOG_ITEM, id }))),
} as unknown as DentalCatalogRepository;

function setup(plan: { status?: TreatmentPlanStatus; currency?: string } = {}) {
  const repo = new InMemoryTreatmentPlanRepository();
  repo.seedPlan({
    id: 'plan1',
    status: plan.status ?? TreatmentPlanStatus.DRAFT,
    currency: plan.currency ?? 'COP',
  });
  const policy = testDiscountPolicy();
  return {
    repo,
    add: new AddTreatmentPlanItemUseCase(
      repo,
      catalogPricing(catalog),
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

const NEW_ITEM = { toothNumber: '11', catalogItemId: 'cat1', price: 1000 };

describe('Tope de descuento por rol en los ítems del plan (DX-204)', () => {
  describe('alta de un ítem', () => {
    it('un DENTIST no puede dar un 15 %: 403 en español y no se crea', async () => {
      const { add, repo } = setup();
      await expect(
        add.execute(
          'plan1',
          {
            ...NEW_ITEM,
            discount: 150,
            discountReason: DiscountReason.LOYALTY,
          },
          DENTIST_ACTOR,
        ),
      ).rejects.toThrow(
        new ForbiddenException(
          'Tu rol permite hasta un 10 % de descuento por ítem.',
        ),
      );
      expect((await repo.findPlanById('plan1'))!.items).toHaveLength(0);
    });

    it('un DENTIST da su 10 % sin motivo y queda a su nombre, con hora y sede', async () => {
      const { add } = setup();
      const item = await add.execute(
        'plan1',
        { ...NEW_ITEM, discount: 100 },
        DENTIST_ACTOR,
      );
      expect(item).toMatchObject({
        discount: 100,
        discountReason: null,
        discountById: DENTIST_ACTOR.userId,
        discountAt: DISCOUNT_NOW,
        discountLocationId: 'loc-1',
      });
    });

    it('la asistente (0 %) no descuenta', async () => {
      const { add } = setup();
      await expect(
        add.execute('plan1', { ...NEW_ITEM, discount: 1 }, ASSISTANT_ACTOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('por encima del umbral, 422 si falta el motivo; con motivo, se guarda', async () => {
      const { add } = setup();
      await expect(
        add.execute('plan1', { ...NEW_ITEM, discount: 150 }, ADMIN_ACTOR),
      ).rejects.toThrow(
        new UnprocessableEntityException(
          'El descuento supera el 10 %: indica el motivo.',
        ),
      );
      const item = await add.execute(
        'plan1',
        {
          ...NEW_ITEM,
          discount: 150,
          discountReason: DiscountReason.OTHER,
          discountReasonNote: '  Convenio empresa  ',
        },
        ADMIN_ACTOR,
      );
      expect(item).toMatchObject({
        discountReason: DiscountReason.OTHER,
        discountReasonNote: 'Convenio empresa',
        discountById: ADMIN_ACTOR.userId,
      });
    });

    it('«Otro» sin nota y nota sin motivo: 422', async () => {
      const { add } = setup();
      await expect(
        add.execute(
          'plan1',
          { ...NEW_ITEM, discount: 150, discountReason: DiscountReason.OTHER },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(
        add.execute(
          'plan1',
          { ...NEW_ITEM, discount: 50, discountReasonNote: 'Sin motivo' },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('un ítem sin descuento no consulta la política ni guarda autor', async () => {
      const { add } = setup();
      const item = await add.execute('plan1', NEW_ITEM, ASSISTANT_ACTOR);
      expect(item).toMatchObject({
        discount: 0,
        discountById: null,
        discountAt: null,
      });
    });

    it('en un plan aceptado (sin firma) no se añade un ítem con descuento', async () => {
      const { add } = setup({ status: TreatmentPlanStatus.ACCEPTED });
      await expect(
        add.execute('plan1', { ...NEW_ITEM, discount: 50 }, ADMIN_ACTOR),
      ).rejects.toThrow(
        new ConflictException(ACCEPTED_PLAN_DISCOUNT_LOCKED_MESSAGE),
      );
    });
  });

  describe('edición de un ítem', () => {
    function withItem(
      over: Parameters<InMemoryTreatmentPlanRepository['seedItem']>[0] = {},
      plan = {},
    ) {
      const ctx = setup(plan);
      ctx.repo.seedItem({ id: 'item1', planId: 'plan1', price: 1000, ...over });
      return ctx;
    }

    it('un DENTIST no puede subir a un 15 %: 403 y el ítem no cambia', async () => {
      const { update, repo } = withItem();
      await expect(
        update.execute(
          'item1',
          { discount: 150, discountReason: DiscountReason.LOYALTY },
          DENTIST_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect((await repo.findItemById('item1'))!.discount).toBe(0);
    });

    it('editar notas de un ítem que descontó la administración no exige permiso', async () => {
      const { update } = withItem({
        discount: 300,
        discountReason: DiscountReason.PROMOTION,
        discountById: ADMIN_ACTOR.userId,
      });
      const item = await update.execute(
        'item1',
        { notes: 'Ojo' },
        ASSISTANT_ACTOR,
      );
      expect(item).toMatchObject({
        discount: 300,
        discountById: ADMIN_ACTOR.userId,
        notes: 'Ojo',
      });
    });

    it('cambiar el precio de un ítem con descuento vuelve a comprobar su %', async () => {
      const { update } = withItem({
        discount: 100,
        discountById: DENTIST_ACTOR.userId,
      });
      // 100 de 800 = 12,5 % > 10 %.
      await expect(
        update.execute('item1', { price: 800 }, DENTIST_ACTOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('conserva el motivo si la petición no trae otro', async () => {
      const { update } = withItem({
        discount: 200,
        discountReason: DiscountReason.LOYALTY,
      });
      const item = await update.execute(
        'item1',
        { discount: 250 },
        ADMIN_ACTOR,
      );
      expect(item).toMatchObject({
        discount: 250,
        discountReason: DiscountReason.LOYALTY,
        discountById: ADMIN_ACTOR.userId,
      });
    });

    it('quitar el descuento borra motivo, autor, hora y sede (cualquier rol)', async () => {
      const { update } = withItem({
        discount: 200,
        discountReason: DiscountReason.LOYALTY,
        discountById: ADMIN_ACTOR.userId,
        discountAt: DISCOUNT_NOW,
        discountLocationId: 'loc-1',
      });
      const item = await update.execute(
        'item1',
        { discount: 0 },
        ASSISTANT_ACTOR,
      );
      expect(item).toMatchObject({
        discount: 0,
        discountReason: null,
        discountReasonNote: null,
        discountById: null,
        discountAt: null,
        discountLocationId: null,
      });
    });

    it('un plan aceptado sin firma no se vuelve a descontar (409)', async () => {
      const { update } = withItem(
        { status: TreatmentPlanItemStatus.ACCEPTED },
        { status: TreatmentPlanStatus.ACCEPTED },
      );
      await expect(
        update.execute('item1', { discount: 50 }, ADMIN_ACTOR),
      ).rejects.toThrow(
        new ConflictException(ACCEPTED_PLAN_DISCOUNT_LOCKED_MESSAGE),
      );
      // Avanzar el tratamiento sigue permitido.
      const done = await update.execute(
        'item1',
        { status: TreatmentPlanItemStatus.DONE },
        ADMIN_ACTOR,
      );
      expect(done.status).toBe(TreatmentPlanItemStatus.DONE);
    });
  });

  describe('«Descuento %» sobre varios ítems', () => {
    function withItems(currency: string, prices: number[]) {
      const ctx = setup({ currency });
      prices.forEach((price, i) =>
        ctx.repo.seedItem({ id: `item${i + 1}`, planId: 'plan1', price }),
      );
      return ctx;
    }

    it('COP: 7,5 % de tres ítems, sin decimales', async () => {
      const { bulk } = withItems('COP', [85000, 123457, 99999]);
      const { items } = await bulk.execute(
        'plan1',
        { itemIds: ['item1', 'item2', 'item3'], percent: 7.5 },
        DENTIST_ACTOR,
      );
      expect(items.map((i) => i.discount)).toEqual([6375, 9259, 7500]);
      expect(items.every((i) => i.discountById === DENTIST_ACTOR.userId)).toBe(
        true,
      );
    });

    it('EUR: a céntimos', async () => {
      const { bulk } = withItems('EUR', [85.55, 123.45, 0.99]);
      const { items } = await bulk.execute(
        'plan1',
        { itemIds: ['item1', 'item2', 'item3'], percent: 7.5 },
        DENTIST_ACTOR,
      );
      expect(items.map((i) => i.discount)).toEqual([6.42, 9.26, 0.07]);
    });

    it('el tope se respeta ítem a ítem aunque el redondeo lo pase', async () => {
      const { bulk } = withItems('COP', [1005, 2000, 3333]);
      const { items } = await bulk.execute(
        'plan1',
        { itemIds: ['item1', 'item2', 'item3'], percent: 10 },
        DENTIST_ACTOR,
      );
      // 100,5 → 101 superaría el 10 %: queda en 100. 333,3 → 333.
      expect(items.map((i) => i.discount)).toEqual([100, 200, 333]);
    });

    it('un % por encima del tope del rol: 403 y nada cambia', async () => {
      const { bulk, repo } = withItems('COP', [1000, 2000, 3000]);
      await expect(
        bulk.execute(
          'plan1',
          {
            itemIds: ['item1', 'item2', 'item3'],
            percent: 15,
            discountReason: DiscountReason.LOYALTY,
          },
          DENTIST_ACTOR,
        ),
      ).rejects.toThrow('Tu rol permite hasta un 10 % de descuento por ítem.');
      const plan = await repo.findPlanById('plan1');
      expect(plan!.items.map((i) => i.discount)).toEqual([0, 0, 0]);
    });

    it('por encima del umbral exige el motivo (422) y nada cambia', async () => {
      const { bulk, repo } = withItems('COP', [1000, 2000]);
      await expect(
        bulk.execute(
          'plan1',
          { itemIds: ['item1', 'item2'], percent: 20 },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      const plan = await repo.findPlanById('plan1');
      expect(plan!.items.map((i) => i.discount)).toEqual([0, 0]);
      const { items: done } = await bulk.execute(
        'plan1',
        {
          itemIds: ['item1', 'item2'],
          percent: 20,
          discountReason: DiscountReason.FINANCIAL_HARDSHIP,
        },
        ADMIN_ACTOR,
      );
      expect(done.map((i) => [i.discount, i.discountReason])).toEqual([
        [200, DiscountReason.FINANCIAL_HARDSHIP],
        [400, DiscountReason.FINANCIAL_HARDSHIP],
      ]);
    });

    it('un ítem que no es del plan: 404 y nada cambia', async () => {
      const { bulk, repo } = withItems('COP', [1000]);
      repo.seedItem({ id: 'other', planId: 'plan2', price: 1000 });
      await expect(
        bulk.execute(
          'plan1',
          { itemIds: ['item1', 'other'], percent: 5 },
          DENTIST_ACTOR,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((await repo.findItemById('item1'))!.discount).toBe(0);
    });

    it('un plan aceptado no se vuelve a descontar (409)', async () => {
      const ctx = setup({ status: TreatmentPlanStatus.ACCEPTED });
      ctx.repo.seedItem({ id: 'item1', planId: 'plan1', price: 1000 });
      await expect(
        ctx.bulk.execute(
          'plan1',
          { itemIds: ['item1'], percent: 5 },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
