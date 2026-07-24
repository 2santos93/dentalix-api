import { NotFoundException } from '@nestjs/common';
import { TreatmentPlanItemStatus } from '@prisma/client';
import { RemoveTreatmentPlanItemUseCase } from './remove-treatment-plan-item.use-case';
import { GetTreatmentPlanUseCase } from './get-treatment-plan.use-case';
import {
  TreatmentPlan,
  TreatmentPlanWithItems,
} from '../../domain/entities/treatment-plan.entity';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';
import { TreatmentPlanRepository } from '../../domain/ports/treatment-plan-repository.port';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';

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

describe('RemoveTreatmentPlanItemUseCase', () => {
  it('throws NotFoundException when the item does not exist (or belongs to another tenant)', async () => {
    const repo = makeRepo({
      findItemById: (): Promise<TreatmentPlanItem | null> =>
        Promise.resolve(null),
      softDeleteItem: (): Promise<void> =>
        Promise.reject(new Error('softDeleteItem should not be called')),
    });
    const uc = new RemoveTreatmentPlanItemUseCase(repo);

    await expect(uc.execute('missing-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('soft-deletes the item (calls repo.softDeleteItem with the id, not a hard delete)', async () => {
    const existing = fakeItem();
    let softDeletedId: string | undefined;
    const repo = makeRepo({
      findItemById: (id: string): Promise<TreatmentPlanItem | null> =>
        Promise.resolve(id === existing.id ? existing : null),
      softDeleteItem: (id: string): Promise<void> => {
        softDeletedId = id;
        return Promise.resolve();
      },
    });
    const uc = new RemoveTreatmentPlanItemUseCase(repo);

    await uc.execute(existing.id);

    expect(softDeletedId).toBe(existing.id);
  });

  // Real in-memory filtering, end-to-end through GetTreatmentPlanUseCase:
  // proves the removed item stops appearing in the plan detail AND the
  // total drops accordingly — not just that softDeleteItem was called.
  it('after removal, the item no longer appears in GetTreatmentPlan and the total drops', async () => {
    const repo = new InMemoryTreatmentPlanRepository();
    const plan = repo.seedPlan({ patientId: 'p1' });
    repo.seedItem({ planId: plan.id, price: 100 });
    const toRemove = repo.seedItem({ planId: plan.id, price: 250 });
    const removeUc = new RemoveTreatmentPlanItemUseCase(repo);
    const getUc = new GetTreatmentPlanUseCase(repo);

    const before = await getUc.execute(plan.id);
    expect(before.total).toBe(350);

    await removeUc.execute(toRemove.id);

    const after = await getUc.execute(plan.id);
    expect(after.total).toBe(100);
    expect(after.items.map((i) => i.id)).not.toContain(toRemove.id);
  });
});
