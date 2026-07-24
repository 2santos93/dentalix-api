import { NotFoundException } from '@nestjs/common';
import { ToothSurface, TreatmentPlanItemStatus } from '@prisma/client';
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

describe('UpdateTreatmentPlanItemUseCase', () => {
  it('throws NotFoundException when the item does not exist (or belongs to another tenant)', async () => {
    const repo = makeRepo({
      findItemById: (): Promise<TreatmentPlanItem | null> =>
        Promise.resolve(null),
      updateItem: (): Promise<TreatmentPlanItem> =>
        Promise.reject(new Error('updateItem should not be called')),
    });
    const uc = new UpdateTreatmentPlanItemUseCase(repo);

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
    const uc = new UpdateTreatmentPlanItemUseCase(repo);

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
    const uc = new UpdateTreatmentPlanItemUseCase(repo);

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
    const uc = new UpdateTreatmentPlanItemUseCase(repo);

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
});
