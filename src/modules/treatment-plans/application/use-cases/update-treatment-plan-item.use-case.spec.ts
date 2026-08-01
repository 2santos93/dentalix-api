import { NotFoundException } from '@nestjs/common';
import {
  CatalogKind,
  ToothSurface,
  TreatmentPlanItemStatus,
} from '@prisma/client';
import { UpdateTreatmentPlanItemUseCase } from './update-treatment-plan-item.use-case';
import {
  TreatmentPlan,
  TreatmentPlanWithItems,
} from '../../domain/entities/treatment-plan.entity';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';
import {
  TreatmentPlanRepository,
  UpdateTreatmentPlanItemRepoInput,
} from '../../domain/ports/treatment-plan-repository.port';
import { ToothRecord } from '../../../odontogram/domain/entities/tooth-record.entity';
import {
  CreateToothRecordRepoInput,
  ToothRecordRepository,
} from '../../../odontogram/domain/ports/tooth-record-repository.port';
import { DentalCatalogItem } from '../../../dental-catalog/domain/entities/dental-catalog-item.entity';
import { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';

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
      Promise.resolve(null),
    listPlansByPatient: (): Promise<TreatmentPlan[]> => Promise.resolve([]),
    updatePlan: (): Promise<TreatmentPlan> =>
      Promise.reject(new Error('not implemented in this fake')),
    addItem: (): Promise<TreatmentPlanItem> =>
      Promise.reject(new Error('not implemented in this fake')),
    findItemById: (): Promise<TreatmentPlanItem | null> =>
      Promise.resolve(null),
    updateItem: (): Promise<TreatmentPlanItem> =>
      Promise.reject(new Error('not implemented in this fake')),
    softDeleteItem: (): Promise<void> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

function makeToothRepo(
  overrides: Partial<ToothRecordRepository> = {},
): ToothRecordRepository {
  return {
    create: (): Promise<ToothRecord> =>
      Promise.reject(new Error('not implemented in this fake')),
    listByPatient: (): Promise<ToothRecord[]> => Promise.resolve([]),
    listByTooth: (): Promise<ToothRecord[]> => Promise.resolve([]),
    findBySourcePlanItem: (): Promise<ToothRecord | null> =>
      Promise.resolve(null),
    ...overrides,
  };
}

function makeCatalogRepo(
  overrides: Partial<DentalCatalogRepository> = {},
): DentalCatalogRepository {
  return {
    create: (): Promise<DentalCatalogItem> =>
      Promise.reject(new Error('not implemented in this fake')),
    list: (): Promise<DentalCatalogItem[]> => Promise.resolve([]),
    findById: (): Promise<DentalCatalogItem | null> => Promise.resolve(null),
    update: (): Promise<DentalCatalogItem> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

// Minimal plan whose only field the use case reads is `patientId`.
const planWithPatient = {
  patientId: 'pat1',
} as unknown as TreatmentPlanWithItems;

describe('UpdateTreatmentPlanItemUseCase', () => {
  it('throws NotFoundException when the item does not exist (or belongs to another tenant)', async () => {
    const repo = makeRepo({
      findItemById: (): Promise<TreatmentPlanItem | null> =>
        Promise.resolve(null),
      updateItem: (): Promise<TreatmentPlanItem> =>
        Promise.reject(new Error('updateItem should not be called')),
    });
    const uc = new UpdateTreatmentPlanItemUseCase(
      repo,
      makeToothRepo(),
      makeCatalogRepo(),
    );

    await expect(
      uc.execute('missing-id', { price: 100 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('changes price', async () => {
    const existing = fakeItem();
    let receivedPatch: UpdateTreatmentPlanItemRepoInput | undefined;
    const repo = makeRepo({
      findItemById: (id: string): Promise<TreatmentPlanItem | null> =>
        Promise.resolve(id === existing.id ? existing : null),
      updateItem: (
        _id: string,
        patch: UpdateTreatmentPlanItemRepoInput,
      ): Promise<TreatmentPlanItem> => {
        receivedPatch = patch;
        return Promise.resolve({
          ...existing,
          price: patch.price ?? existing.price,
        });
      },
    });
    const uc = new UpdateTreatmentPlanItemUseCase(
      repo,
      makeToothRepo(),
      makeCatalogRepo(),
    );

    const result = await uc.execute(existing.id, { price: 999 });

    expect(result.price).toBe(999);
    expect(receivedPatch).toEqual({ price: 999 });
  });

  it.each([
    TreatmentPlanItemStatus.PROPOSED,
    TreatmentPlanItemStatus.ACCEPTED,
    TreatmentPlanItemStatus.DONE,
  ])('allows changing status to %s', async (status) => {
    const existing = fakeItem();
    const repo = makeRepo({
      findItemById: (id: string): Promise<TreatmentPlanItem | null> =>
        Promise.resolve(id === existing.id ? existing : null),
      updateItem: (): Promise<TreatmentPlanItem> =>
        Promise.resolve({ ...existing, status }),
    });
    const uc = new UpdateTreatmentPlanItemUseCase(
      repo,
      makeToothRepo(),
      makeCatalogRepo(),
    );

    const result = await uc.execute(existing.id, { status });

    expect(result.status).toBe(status);
  });

  it('allows changing surfaces and notes', async () => {
    const existing = fakeItem();
    let receivedPatch: UpdateTreatmentPlanItemRepoInput | undefined;
    const repo = makeRepo({
      findItemById: (id: string): Promise<TreatmentPlanItem | null> =>
        Promise.resolve(id === existing.id ? existing : null),
      updateItem: (
        _id: string,
        patch: UpdateTreatmentPlanItemRepoInput,
      ): Promise<TreatmentPlanItem> => {
        receivedPatch = patch;
        return Promise.resolve({
          ...existing,
          surfaces: patch.surfaces ?? existing.surfaces,
          notes: patch.notes ?? existing.notes,
        });
      },
    });
    const uc = new UpdateTreatmentPlanItemUseCase(
      repo,
      makeToothRepo(),
      makeCatalogRepo(),
    );

    const result = await uc.execute(existing.id, {
      surfaces: [ToothSurface.DISTAL],
      notes: 'Actualizado',
    });

    expect(result.surfaces).toEqual([ToothSurface.DISTAL]);
    expect(result.notes).toBe('Actualizado');
    expect(receivedPatch).toEqual({
      surfaces: [ToothSurface.DISTAL],
      notes: 'Actualizado',
    });
  });

  describe('Pieza B — mirror to odontogram on DONE', () => {
    it('creates a tooth record linked to the item when it transitions to DONE', async () => {
      const existing = fakeItem({ status: TreatmentPlanItemStatus.PROPOSED });
      const repo = makeRepo({
        findItemById: (): Promise<TreatmentPlanItem | null> =>
          Promise.resolve(existing),
        updateItem: (): Promise<TreatmentPlanItem> =>
          Promise.resolve({
            ...existing,
            status: TreatmentPlanItemStatus.DONE,
          }),
        findPlanById: (): Promise<TreatmentPlanWithItems | null> =>
          Promise.resolve(planWithPatient),
      });
      let received: CreateToothRecordRepoInput | undefined;
      const toothRepo = makeToothRepo({
        findBySourcePlanItem: (): Promise<ToothRecord | null> =>
          Promise.resolve(null),
        create: (input: CreateToothRecordRepoInput): Promise<ToothRecord> => {
          received = input;
          return Promise.resolve({} as ToothRecord);
        },
      });
      const catalog = makeCatalogRepo({
        findById: (): Promise<DentalCatalogItem | null> =>
          Promise.resolve({ kind: CatalogKind.PROCEDURE } as DentalCatalogItem),
      });
      const uc = new UpdateTreatmentPlanItemUseCase(repo, toothRepo, catalog);

      const result = await uc.execute(
        existing.id,
        { status: TreatmentPlanItemStatus.DONE },
        'user1',
      );

      expect(result.status).toBe(TreatmentPlanItemStatus.DONE);
      expect(received).toEqual({
        patientId: 'pat1',
        toothNumber: '11',
        surfaces: [],
        kind: CatalogKind.PROCEDURE,
        catalogItemId: 'cat1',
        status: 'COMPLETED',
        performedById: 'user1',
        sourcePlanItemId: 'item1',
      });
    });

    it('does not create a second tooth record if the item was already mirrored (dedupe)', async () => {
      const existing = fakeItem({ status: TreatmentPlanItemStatus.PROPOSED });
      const repo = makeRepo({
        findItemById: (): Promise<TreatmentPlanItem | null> =>
          Promise.resolve(existing),
        updateItem: (): Promise<TreatmentPlanItem> =>
          Promise.resolve({
            ...existing,
            status: TreatmentPlanItemStatus.DONE,
          }),
        findPlanById: (): Promise<TreatmentPlanWithItems | null> =>
          Promise.resolve(planWithPatient),
      });
      const create = jest.fn();
      const toothRepo = makeToothRepo({
        findBySourcePlanItem: (): Promise<ToothRecord | null> =>
          Promise.resolve({ id: 'existing-record' } as ToothRecord),
        create,
      });
      const uc = new UpdateTreatmentPlanItemUseCase(
        repo,
        toothRepo,
        makeCatalogRepo(),
      );

      await uc.execute(existing.id, { status: TreatmentPlanItemStatus.DONE });

      expect(create).not.toHaveBeenCalled();
    });

    it('does not mirror when the item was already DONE (no transition)', async () => {
      const existing = fakeItem({ status: TreatmentPlanItemStatus.DONE });
      const repo = makeRepo({
        findItemById: (): Promise<TreatmentPlanItem | null> =>
          Promise.resolve(existing),
        updateItem: (): Promise<TreatmentPlanItem> =>
          Promise.resolve({ ...existing, price: 300 }),
      });
      const create = jest.fn();
      const uc = new UpdateTreatmentPlanItemUseCase(
        repo,
        makeToothRepo({ create }),
        makeCatalogRepo(),
      );

      const result = await uc.execute(existing.id, { price: 300 });

      expect(result.price).toBe(300);
      expect(create).not.toHaveBeenCalled();
    });

    it('still succeeds if mirroring fails (best-effort)', async () => {
      const existing = fakeItem({ status: TreatmentPlanItemStatus.PROPOSED });
      const repo = makeRepo({
        findItemById: (): Promise<TreatmentPlanItem | null> =>
          Promise.resolve(existing),
        updateItem: (): Promise<TreatmentPlanItem> =>
          Promise.resolve({
            ...existing,
            status: TreatmentPlanItemStatus.DONE,
          }),
        findPlanById: (): Promise<TreatmentPlanWithItems | null> =>
          Promise.resolve(planWithPatient),
      });
      const toothRepo = makeToothRepo({
        findBySourcePlanItem: (): Promise<ToothRecord | null> =>
          Promise.resolve(null),
        create: (): Promise<ToothRecord> =>
          Promise.reject(new Error('odontogram write failed')),
      });
      const catalog = makeCatalogRepo({
        findById: (): Promise<DentalCatalogItem | null> =>
          Promise.resolve({ kind: CatalogKind.PROCEDURE } as DentalCatalogItem),
      });
      const uc = new UpdateTreatmentPlanItemUseCase(repo, toothRepo, catalog);

      const result = await uc.execute(existing.id, {
        status: TreatmentPlanItemStatus.DONE,
      });

      expect(result.status).toBe(TreatmentPlanItemStatus.DONE);
    });
  });
});
