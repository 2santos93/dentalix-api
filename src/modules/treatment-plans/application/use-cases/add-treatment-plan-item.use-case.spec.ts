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
  TreatmentPlanRepository,
} from '../../domain/ports/treatment-plan-repository.port';
import { DentalCatalogItem } from '../../../dental-catalog/domain/entities/dental-catalog-item.entity';
import { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';

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
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
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
    price: 200,
    status: TreatmentPlanItemStatus.PROPOSED,
    notes: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<TreatmentPlanRepository> = {},
): TreatmentPlanRepository {
  return {
    createPlan: (): Promise<TreatmentPlan> =>
      Promise.reject(new Error('not implemented in this fake')),
    findPlanById: (): Promise<TreatmentPlanWithItems | null> =>
      Promise.resolve(fakePlanWithItems()),
    listPlansByPatient: (): Promise<TreatmentPlan[]> => Promise.resolve([]),
    updatePlan: (): Promise<TreatmentPlan> =>
      Promise.reject(new Error('not implemented in this fake')),
    addItem: (
      input: AddTreatmentPlanItemRepoInput,
    ): Promise<TreatmentPlanItem> =>
      Promise.resolve(
        fakeItem({
          planId: input.planId,
          toothNumber: input.toothNumber,
          surfaces: input.surfaces ?? [],
          catalogItemId: input.catalogItemId,
          price: input.price,
          notes: input.notes ?? null,
        }),
      ),
    findItemById: (): Promise<TreatmentPlanItem | null> =>
      Promise.resolve(null),
    updateItem: (): Promise<TreatmentPlanItem> =>
      Promise.reject(new Error('not implemented in this fake')),
    softDeleteItem: (): Promise<void> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
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
    const uc = new AddTreatmentPlanItemUseCase(repo, catalogRepo);

    await expect(
      uc.execute('missing-plan', { toothNumber: '11', catalogItemId: 'cat1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException when the catalog item does not exist (or belongs to another tenant)', async () => {
    const repo = makeRepo();
    const catalogRepo = makeCatalogRepo({
      findById: (): Promise<DentalCatalogItem | null> => Promise.resolve(null),
    });
    const uc = new AddTreatmentPlanItemUseCase(repo, catalogRepo);

    await expect(
      uc.execute('plan1', { toothNumber: '11', catalogItemId: 'missing-cat' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('uses the explicit price when provided, even if the catalog item has a defaultPrice', async () => {
    const repo = makeRepo();
    const catalogRepo = makeCatalogRepo({
      findById: (): Promise<DentalCatalogItem | null> =>
        Promise.resolve(fakeCatalogItem({ defaultPrice: 200 })),
    });
    const uc = new AddTreatmentPlanItemUseCase(repo, catalogRepo);

    const result = await uc.execute('plan1', {
      toothNumber: '11',
      catalogItemId: 'cat1',
      price: 350,
    });

    expect(result.price).toBe(350);
  });

  it('falls back to the catalog item defaultPrice when price is not provided', async () => {
    let captured: AddTreatmentPlanItemRepoInput | undefined;
    const repo = makeRepo({
      addItem: (
        input: AddTreatmentPlanItemRepoInput,
      ): Promise<TreatmentPlanItem> => {
        captured = input;
        return Promise.resolve(fakeItem({ price: input.price }));
      },
    });
    const catalogRepo = makeCatalogRepo({
      findById: (): Promise<DentalCatalogItem | null> =>
        Promise.resolve(fakeCatalogItem({ defaultPrice: 275 })),
    });
    const uc = new AddTreatmentPlanItemUseCase(repo, catalogRepo);

    const result = await uc.execute('plan1', {
      toothNumber: '11',
      catalogItemId: 'cat1',
    });

    expect(result.price).toBe(275);
    expect(captured?.price).toBe(275);
  });

  it('throws BadRequestException when price is omitted AND the catalog item has no defaultPrice (null)', async () => {
    const repo = makeRepo();
    const catalogRepo = makeCatalogRepo({
      findById: (): Promise<DentalCatalogItem | null> =>
        Promise.resolve(fakeCatalogItem({ defaultPrice: null })),
    });
    const uc = new AddTreatmentPlanItemUseCase(repo, catalogRepo);

    await expect(
      uc.execute('plan1', { toothNumber: '11', catalogItemId: 'cat1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('new item starts in PROPOSED status', async () => {
    const repo = makeRepo();
    const catalogRepo = makeCatalogRepo();
    const uc = new AddTreatmentPlanItemUseCase(repo, catalogRepo);

    const result = await uc.execute('plan1', {
      toothNumber: '11',
      catalogItemId: 'cat1',
      price: 100,
    });

    expect(result.status).toBe(TreatmentPlanItemStatus.PROPOSED);
  });

  it('passes surfaces and notes through untouched', async () => {
    let captured: AddTreatmentPlanItemRepoInput | undefined;
    const repo = makeRepo({
      addItem: (
        input: AddTreatmentPlanItemRepoInput,
      ): Promise<TreatmentPlanItem> => {
        captured = input;
        return Promise.resolve(fakeItem());
      },
    });
    const catalogRepo = makeCatalogRepo();
    const uc = new AddTreatmentPlanItemUseCase(repo, catalogRepo);

    await uc.execute('plan1', {
      toothNumber: '26',
      surfaces: [ToothSurface.OCCLUSAL, ToothSurface.MESIAL],
      catalogItemId: 'cat1',
      price: 100,
      notes: 'Caries profunda',
    });

    expect(captured?.surfaces).toEqual([
      ToothSurface.OCCLUSAL,
      ToothSurface.MESIAL,
    ]);
    expect(captured?.notes).toBe('Caries profunda');
  });
});
