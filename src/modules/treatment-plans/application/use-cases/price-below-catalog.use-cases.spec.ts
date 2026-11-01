import { referenceCurrencyDigitsCatalog } from '../../../../shared/money/__fixtures__/reference-currency-digits';
import {
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CatalogKind,
  DiscountReason,
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
import {
  priceBelowCatalogCapMessage,
  priceBelowCatalogReasonMessage,
} from '../../../discounts/domain/effective-discount';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogItem } from '../../../dental-catalog/domain/entities/dental-catalog-item.entity';

// SEC-041: bajar el precio por debajo del de catálogo cuenta como descuento
// (tope del rol y motivo de DX-204), en el alta, en la edición y en bloque.
const CROWN = {
  id: 'crown',
  kind: CatalogKind.PROCEDURE,
  defaultPrice: 1_000_000,
  allowDiscount: true,
} as DentalCatalogItem;
/** Ítem «libre»: el catálogo no tiene precio. */
const FREE = {
  id: 'free',
  kind: CatalogKind.PROCEDURE,
  defaultPrice: null,
  allowDiscount: true,
} as DentalCatalogItem;

const catalog = {
  findById: (id: string) =>
    Promise.resolve([CROWN, FREE].find((c) => c.id === id) ?? { ...CROWN, id }),
  // DX-105: el «Descuento %» mira si cada procedimiento admite descuentos.
  findByIds: (ids: string[]) =>
    Promise.resolve(ids.map((id) => ({ ...CROWN, id }))),
} as unknown as DentalCatalogRepository;

function setup(plan: { status?: TreatmentPlanStatus } = {}) {
  const repo = new InMemoryTreatmentPlanRepository();
  repo.seedPlan({
    id: 'plan1',
    status: plan.status ?? TreatmentPlanStatus.DRAFT,
    currency: 'COP',
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

const CROWN_ITEM = { toothNumber: '11', catalogItemId: 'crown' };

describe('Precio por debajo del de catálogo = descuento (SEC-041)', () => {
  describe('alta', () => {
    it('DENTIST (10 %) al 50 % del catálogo: 403 en español y no se crea', async () => {
      const { add, repo } = setup();
      await expect(
        add.execute('plan1', { ...CROWN_ITEM, price: 500_000 }, DENTIST_ACTOR),
      ).rejects.toThrow(
        new ForbiddenException(priceBelowCatalogCapMessage(10)),
      );
      expect((await repo.findPlanById('plan1'))!.items).toHaveLength(0);
    });

    it('DENTIST al 95 %: se crea, guarda el precio de catálogo y la firma del descuento', async () => {
      const { add } = setup();
      const item = await add.execute(
        'plan1',
        { ...CROWN_ITEM, price: 950_000 },
        DENTIST_ACTOR,
      );
      expect(item).toMatchObject({
        price: 950_000,
        catalogPrice: 1_000_000,
        discount: 0,
        discountById: DENTIST_ACTOR.userId,
        discountAt: DISCOUNT_NOW,
        discountLocationId: 'loc-1',
      });
    });

    it('la rebaja y el descuento se suman contra el tope', async () => {
      const { add } = setup();
      await expect(
        add.execute(
          'plan1',
          { ...CROWN_ITEM, price: 950_000, discount: 60_000 },
          DENTIST_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('por encima del umbral sin motivo: 422 «Indica el motivo del descuento»; con motivo, se guarda', async () => {
      const { add } = setup();
      await expect(
        add.execute('plan1', { ...CROWN_ITEM, price: 800_000 }, ADMIN_ACTOR),
      ).rejects.toThrow(
        new UnprocessableEntityException(priceBelowCatalogReasonMessage(10)),
      );
      const item = await add.execute(
        'plan1',
        {
          ...CROWN_ITEM,
          price: 800_000,
          discountReason: DiscountReason.LOYALTY,
        },
        ADMIN_ACTOR,
      );
      expect(item).toMatchObject({
        price: 800_000,
        catalogPrice: 1_000_000,
        discountReason: DiscountReason.LOYALTY,
        discountById: ADMIN_ACTOR.userId,
      });
    });

    it('ADMIN puede fijar cualquier precio (con motivo)', async () => {
      const { add } = setup();
      const item = await add.execute(
        'plan1',
        {
          ...CROWN_ITEM,
          price: 1,
          discountReason: DiscountReason.SERVICE_RECOVERY,
        },
        ADMIN_ACTOR,
      );
      expect(item).toMatchObject({ price: 1, discountById: 'admin-1' });
    });

    it('subir el precio sobre el catálogo es libre (incluso la asistente) y no firma descuento', async () => {
      const { add } = setup();
      const item = await add.execute(
        'plan1',
        { ...CROWN_ITEM, price: 1_200_000 },
        ASSISTANT_ACTOR,
      );
      expect(item).toMatchObject({
        price: 1_200_000,
        catalogPrice: 1_000_000,
        discountById: null,
        discountReason: null,
      });
    });

    it('sin precio, toma el de catálogo y no hay descuento', async () => {
      const { add } = setup();
      const item = await add.execute('plan1', CROWN_ITEM, ASSISTANT_ACTOR);
      expect(item).toMatchObject({
        price: 1_000_000,
        catalogPrice: 1_000_000,
        discountById: null,
      });
    });

    it('un ítem libre (sin precio de catálogo) no se trata como descuento', async () => {
      const { add } = setup();
      const item = await add.execute(
        'plan1',
        { toothNumber: '11', catalogItemId: 'free', price: 1 },
        ASSISTANT_ACTOR,
      );
      expect(item).toMatchObject({
        price: 1,
        catalogPrice: null,
        discountById: null,
      });
    });

    it('en un plan aceptado (sin firma) no se añade un ítem rebajado (409)', async () => {
      const { add } = setup({ status: TreatmentPlanStatus.ACCEPTED });
      await expect(
        add.execute('plan1', { ...CROWN_ITEM, price: 990_000 }, ADMIN_ACTOR),
      ).rejects.toThrow(
        new ConflictException(ACCEPTED_PLAN_DISCOUNT_LOCKED_MESSAGE),
      );
    });
  });

  describe('edición', () => {
    function withCrown(
      over: Parameters<InMemoryTreatmentPlanRepository['seedItem']>[0] = {},
      plan: { status?: TreatmentPlanStatus } = {},
    ) {
      const ctx = setup(plan);
      ctx.repo.seedItem({
        id: 'item1',
        planId: 'plan1',
        catalogItemId: 'crown',
        catalogPrice: 1_000_000,
        price: 1_000_000,
        ...over,
      });
      return ctx;
    }

    it('ASSISTANT baja el precio: 403 y el ítem no cambia', async () => {
      const { update, repo } = withCrown();
      await expect(
        update.execute('item1', { price: 1 }, ASSISTANT_ACTOR),
      ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
      expect((await repo.findItemById('item1'))!.price).toBe(1_000_000);
    });

    it('ASSISTANT sube el precio: 200, sin firma de descuento', async () => {
      const { update } = withCrown();
      const item = await update.execute(
        'item1',
        { price: 1_100_000 },
        ASSISTANT_ACTOR,
      );
      expect(item).toMatchObject({ price: 1_100_000, discountById: null });
    });

    it('subir el precio de un ítem rebajado por la administración es libre y conserva su firma', async () => {
      const { update } = withCrown({
        price: 800_000,
        discountReason: DiscountReason.LOYALTY,
        discountById: ADMIN_ACTOR.userId,
        discountAt: DISCOUNT_NOW,
      });
      const item = await update.execute(
        'item1',
        { price: 900_000 },
        ASSISTANT_ACTOR,
      );
      expect(item).toMatchObject({
        price: 900_000,
        discountReason: DiscountReason.LOYALTY,
        discountById: ADMIN_ACTOR.userId,
      });
    });

    it('volver al precio de catálogo deja el ítem sin descuento (borra la firma)', async () => {
      const { update } = withCrown({
        price: 800_000,
        discountReason: DiscountReason.LOYALTY,
        discountById: ADMIN_ACTOR.userId,
        discountAt: DISCOUNT_NOW,
        discountLocationId: 'loc-1',
      });
      const item = await update.execute(
        'item1',
        { price: 1_000_000 },
        ASSISTANT_ACTOR,
      );
      expect(item).toMatchObject({
        discountReason: null,
        discountById: null,
        discountAt: null,
        discountLocationId: null,
      });
    });

    it('DENTIST baja el precio al 95 %: 200 y queda a su nombre', async () => {
      const { update } = withCrown();
      const item = await update.execute(
        'item1',
        { price: 950_000 },
        DENTIST_ACTOR,
      );
      expect(item).toMatchObject({
        price: 950_000,
        discountById: DENTIST_ACTOR.userId,
        discountAt: DISCOUNT_NOW,
      });
    });

    it('ADMIN baja el precio por encima del umbral: 422 sin motivo; con motivo, 200', async () => {
      const { update } = withCrown();
      await expect(
        update.execute('item1', { price: 500_000 }, ADMIN_ACTOR),
      ).rejects.toThrow(
        new UnprocessableEntityException(priceBelowCatalogReasonMessage(10)),
      );
      const item = await update.execute(
        'item1',
        { price: 500_000, discountReason: DiscountReason.FINANCIAL_HARDSHIP },
        ADMIN_ACTOR,
      );
      expect(item).toMatchObject({
        price: 500_000,
        discountReason: DiscountReason.FINANCIAL_HARDSHIP,
        discountById: ADMIN_ACTOR.userId,
      });
    });

    it('un ítem libre puede bajar a 1 sin permiso de descuento', async () => {
      const { update } = withCrown({ catalogPrice: null });
      const item = await update.execute('item1', { price: 1 }, ASSISTANT_ACTOR);
      expect(item).toMatchObject({ price: 1, discountById: null });
    });

    it('quitar el descuento de un ítem rebajado no exige permiso y conserva la firma de la rebaja', async () => {
      const { update } = withCrown({
        price: 900_000,
        discount: 50_000,
        discountReason: DiscountReason.PROMOTION,
        discountById: ADMIN_ACTOR.userId,
      });
      const item = await update.execute(
        'item1',
        { discount: 0 },
        ASSISTANT_ACTOR,
      );
      expect(item).toMatchObject({
        discount: 0,
        discountReason: DiscountReason.PROMOTION,
        discountById: ADMIN_ACTOR.userId,
      });
    });

    it('en un plan aceptado (sin firma) el precio no baja del catálogo (409)', async () => {
      const { update } = withCrown(
        {},
        { status: TreatmentPlanStatus.ACCEPTED },
      );
      await expect(
        update.execute('item1', { price: 990_000 }, ADMIN_ACTOR),
      ).rejects.toThrow(
        new ConflictException(ACCEPTED_PLAN_DISCOUNT_LOCKED_MESSAGE),
      );
    });
  });

  describe('«Descuento %» en bloque', () => {
    it('suma la rebaja de precio: DENTIST con un ítem al 95 % no puede añadir un 6 %', async () => {
      const ctx = setup();
      ctx.repo.seedItem({
        id: 'item1',
        planId: 'plan1',
        catalogPrice: 1_000_000,
        price: 950_000,
      });
      await expect(
        ctx.bulk.execute(
          'plan1',
          { itemIds: ['item1'], percent: 6 },
          DENTIST_ACTOR,
        ),
      ).rejects.toThrow(
        new ForbiddenException(priceBelowCatalogCapMessage(10)),
      );
      expect((await ctx.repo.findItemById('item1'))!.discount).toBe(0);
    });

    it('un 0 % (quitar) en un ítem rebajado no exige permiso y conserva la firma de la rebaja', async () => {
      const ctx = setup();
      ctx.repo.seedItem({
        id: 'item1',
        planId: 'plan1',
        catalogPrice: 1_000_000,
        price: 900_000,
        discount: 10_000,
        discountReason: DiscountReason.LOYALTY,
        discountById: ADMIN_ACTOR.userId,
      });
      const {
        items: [item],
      } = await ctx.bulk.execute(
        'plan1',
        { itemIds: ['item1'], percent: 0 },
        ASSISTANT_ACTOR,
      );
      expect(item).toMatchObject({
        discount: 0,
        discountReason: DiscountReason.LOYALTY,
        discountById: ADMIN_ACTOR.userId,
      });
    });
  });

  // BE-036: el estado del plan se comprueba con la fila del plan bloqueada,
  // dentro de la transacción, no con una lectura previa que puede quedar vieja.
  describe('estado del plan dentro de la transacción (BE-036)', () => {
    /** Lectura previa (fuera de la transacción) que ve el plan aún en borrador. */
    function staleRead(repo: InMemoryTreatmentPlanRepository) {
      const original = repo.findPlanById.bind(repo);
      repo.findPlanById = async (id: string) => {
        const plan = await original(id);
        return plan && { ...plan, status: TreatmentPlanStatus.DRAFT };
      };
    }

    it('alta: el plan ya aceptado cuando se toma el candado → 409', async () => {
      const { add, repo } = setup({ status: TreatmentPlanStatus.ACCEPTED });
      staleRead(repo);
      await expect(
        add.execute('plan1', { ...CROWN_ITEM, price: 990_000 }, DENTIST_ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('edición: el plan ya aceptado cuando se toma el candado → 409 y nada cambia', async () => {
      const { update, repo } = setup({ status: TreatmentPlanStatus.ACCEPTED });
      repo.seedItem({
        id: 'item1',
        planId: 'plan1',
        catalogPrice: 1_000_000,
        price: 1_000_000,
      });
      staleRead(repo);
      await expect(
        update.execute('item1', { price: 990_000 }, DENTIST_ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);
      expect((await repo.findItemById('item1'))!.price).toBe(1_000_000);
    });

    it('bloque: el plan ya cancelado cuando se toma el candado → 409', async () => {
      const { bulk, repo } = setup({ status: TreatmentPlanStatus.CANCELLED });
      repo.seedItem({ id: 'item1', planId: 'plan1', price: 1000 });
      staleRead(repo);
      await expect(
        bulk.execute('plan1', { itemIds: ['item1'], percent: 5 }, ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);
      expect((await repo.findItemById('item1'))!.discount).toBe(0);
    });
  });
});
