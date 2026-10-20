import {
  ADMIN_ACTOR,
  FIXED_CLOCK,
  testDiscountPolicy,
} from './__fixtures__/discount-fixtures';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  CatalogKind,
  ToothSurface,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import { AddTreatmentPlanItemUseCase } from './add-treatment-plan-item.use-case';
import {
  TreatmentPlan,
  TreatmentPlanWithItems,
} from '../../domain/entities/treatment-plan.entity';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';
import {
  AddTreatmentPlanItemRepoInput,
  DecideNewItem,
  TreatmentPlanRepository,
} from '../../domain/ports/treatment-plan-repository.port';
import { DentalCatalogItem } from '../../../dental-catalog/domain/entities/dental-catalog-item.entity';
import { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import { PLAN_WITHOUT_OPTIONS } from './__fixtures__/in-memory-treatment-plan.repository';

function fakePlanWithItems(
  overrides: Partial<TreatmentPlanWithItems> = {},
): TreatmentPlanWithItems {
  return {
    id: 'plan1',
    tenantId: 't1',
    patientId: 'p1',
    status: TreatmentPlanStatus.DRAFT,
    currency: 'USD',
    notes: null,
    createdById: null,
    ...PLAN_WITHOUT_OPTIONS,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    acceptance: null,
    items: [],
    ...overrides,
  };
}

function fakeCatalogItem(
  overrides: Partial<DentalCatalogItem> = {},
): DentalCatalogItem {
  return {
    id: 'cat1',
    tenantId: 't1',
    code: 'OBT-001',
    category: null,
    kind: CatalogKind.PROCEDURE,
    labelEs: 'Obturacion',
    labelEn: null,
    labelPt: null,
    color: '#FFFFFF',
    defaultPrice: 200,
    cupsCode: null,
    allowDiscount: true,
    active: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function fakeItem(
  overrides: Partial<TreatmentPlanItem> = {},
): TreatmentPlanItem {
  return {
    id: 'item1',
    tenantId: 't1',
    planId: 'plan1',
    toothNumber: '11',
    surfaces: [],
    catalogItemId: 'cat1',
    catalogPrice: null,
    price: 200,
    discount: 0,
    discountReason: null,
    discountReasonNote: null,
    discountById: null,
    discountAt: null,
    discountLocationId: null,
    status: TreatmentPlanItemStatus.PROPOSED,
    notes: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * `addItem` del fake: como el real, relee el plan (aquí `findPlanById`) y deja
 * que `decide` lo valide y calcule el ítem; `capture` recibe lo decidido.
 */
function makeRepo(
  overrides: Partial<TreatmentPlanRepository> = {},
  capture?: (input: Omit<AddTreatmentPlanItemRepoInput, 'planId'>) => void,
): TreatmentPlanRepository {
  const repo: TreatmentPlanRepository = {
    createPlan: (): Promise<TreatmentPlan> =>
      Promise.reject(new Error('not implemented in this fake')),
    findPlanById: (): Promise<TreatmentPlanWithItems | null> =>
      Promise.resolve(fakePlanWithItems()),
    listPlansByPatient: (): Promise<TreatmentPlan[]> => Promise.resolve([]),
    updatePlan: (): Promise<TreatmentPlan> =>
      Promise.reject(new Error('not implemented in this fake')),
    addItem: async (
      planId: string,
      decide: DecideNewItem,
    ): Promise<TreatmentPlanItem> => {
      const plan = await repo.findPlanById(planId);
      if (!plan) throw new NotFoundException('Treatment plan not found');
      const input = decide(plan);
      capture?.(input);
      return fakeItem({
        planId,
        toothNumber: input.toothNumber,
        surfaces: input.surfaces ?? [],
        catalogItemId: input.catalogItemId,
        catalogPrice: input.catalogPrice,
        price: input.price,
        notes: input.notes ?? null,
      });
    },
    findItemById: (): Promise<TreatmentPlanItem | null> =>
      Promise.resolve(null),
    updateItem: (): Promise<TreatmentPlanItem> =>
      Promise.reject(new Error('not implemented in this fake')),
    softDeleteItem: (): Promise<void> =>
      Promise.reject(new Error('not implemented in this fake')),
    applyBulkDiscount: (): Promise<TreatmentPlanItem[]> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
  return repo;
}

function makeCatalogRepo(
  overrides: Partial<DentalCatalogRepository> = {},
): DentalCatalogRepository {
  return {
    create: (): Promise<DentalCatalogItem> =>
      Promise.reject(new Error('not implemented in this fake')),
    findById: (): Promise<DentalCatalogItem | null> =>
      Promise.resolve(fakeCatalogItem()),
    list: (): Promise<DentalCatalogItem[]> => Promise.resolve([]),
    findByIds: () => Promise.resolve([]),
    listDirectory: () =>
      Promise.reject(new Error('not implemented in this fake')),
    update: (): Promise<DentalCatalogItem> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

describe('AddTreatmentPlanItemUseCase', () => {
  it('throws NotFoundException when the plan does not exist (or belongs to another tenant)', async () => {
    const repo = makeRepo({
      findPlanById: (): Promise<TreatmentPlanWithItems | null> =>
        Promise.resolve(null),
    });
    const catalogRepo = makeCatalogRepo();
    const uc = new AddTreatmentPlanItemUseCase(
      repo,
      catalogRepo,
      testDiscountPolicy(),
      FIXED_CLOCK,
    );

    await expect(
      uc.execute(
        'missing-plan',
        { toothNumber: '11', catalogItemId: 'cat1' },
        ADMIN_ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException when the catalog item does not exist (or belongs to another tenant)', async () => {
    const repo = makeRepo();
    const catalogRepo = makeCatalogRepo({
      findById: (): Promise<DentalCatalogItem | null> => Promise.resolve(null),
    });
    const uc = new AddTreatmentPlanItemUseCase(
      repo,
      catalogRepo,
      testDiscountPolicy(),
      FIXED_CLOCK,
    );

    await expect(
      uc.execute(
        'plan1',
        { toothNumber: '11', catalogItemId: 'missing-cat' },
        ADMIN_ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('uses the explicit price when provided, even if the catalog item has a defaultPrice', async () => {
    const repo = makeRepo();
    const catalogRepo = makeCatalogRepo({
      findById: (): Promise<DentalCatalogItem | null> =>
        Promise.resolve(fakeCatalogItem({ defaultPrice: 200 })),
    });
    const uc = new AddTreatmentPlanItemUseCase(
      repo,
      catalogRepo,
      testDiscountPolicy(),
      FIXED_CLOCK,
    );

    const result = await uc.execute(
      'plan1',
      {
        toothNumber: '11',
        catalogItemId: 'cat1',
        price: 350,
      },
      ADMIN_ACTOR,
    );

    expect(result.price).toBe(350);
  });

  it('falls back to the catalog item defaultPrice when price is not provided', async () => {
    let captured: Omit<AddTreatmentPlanItemRepoInput, 'planId'> | undefined;
    const repo = makeRepo({}, (input) => {
      captured = input;
    });
    const catalogRepo = makeCatalogRepo({
      findById: (): Promise<DentalCatalogItem | null> =>
        Promise.resolve(fakeCatalogItem({ defaultPrice: 275 })),
    });
    const uc = new AddTreatmentPlanItemUseCase(
      repo,
      catalogRepo,
      testDiscountPolicy(),
      FIXED_CLOCK,
    );

    const result = await uc.execute(
      'plan1',
      {
        toothNumber: '11',
        catalogItemId: 'cat1',
      },
      ADMIN_ACTOR,
    );

    expect(result.price).toBe(275);
    expect(captured?.price).toBe(275);
    // SEC-041: el precio de catálogo queda en el ítem.
    expect(captured?.catalogPrice).toBe(275);
  });

  it('throws BadRequestException when price is omitted AND the catalog item has no defaultPrice (null)', async () => {
    const repo = makeRepo();
    const catalogRepo = makeCatalogRepo({
      findById: (): Promise<DentalCatalogItem | null> =>
        Promise.resolve(fakeCatalogItem({ defaultPrice: null })),
    });
    const uc = new AddTreatmentPlanItemUseCase(
      repo,
      catalogRepo,
      testDiscountPolicy(),
      FIXED_CLOCK,
    );

    await expect(
      uc.execute(
        'plan1',
        { toothNumber: '11', catalogItemId: 'cat1' },
        ADMIN_ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('new item starts in PROPOSED status', async () => {
    const repo = makeRepo();
    const catalogRepo = makeCatalogRepo();
    const uc = new AddTreatmentPlanItemUseCase(
      repo,
      catalogRepo,
      testDiscountPolicy(),
      FIXED_CLOCK,
    );

    const result = await uc.execute(
      'plan1',
      {
        toothNumber: '11',
        catalogItemId: 'cat1',
        price: 200,
      },
      ADMIN_ACTOR,
    );

    expect(result.status).toBe(TreatmentPlanItemStatus.PROPOSED);
  });

  it('passes surfaces and notes through untouched', async () => {
    let captured: Omit<AddTreatmentPlanItemRepoInput, 'planId'> | undefined;
    const repo = makeRepo({}, (input) => {
      captured = input;
    });
    const catalogRepo = makeCatalogRepo();
    const uc = new AddTreatmentPlanItemUseCase(
      repo,
      catalogRepo,
      testDiscountPolicy(),
      FIXED_CLOCK,
    );

    await uc.execute(
      'plan1',
      {
        toothNumber: '26',
        surfaces: [ToothSurface.OCCLUSAL, ToothSurface.MESIAL],
        catalogItemId: 'cat1',
        price: 200,
        notes: 'Caries profunda',
      },
      ADMIN_ACTOR,
    );

    expect(captured?.surfaces).toEqual([
      ToothSurface.OCCLUSAL,
      ToothSurface.MESIAL,
    ]);
    expect(captured?.notes).toBe('Caries profunda');
  });
});
