import { NotFoundException } from '@nestjs/common';
import { TreatmentPlanItemStatus, TreatmentPlanStatus } from '@prisma/client';
import { GetTreatmentPlanUseCase } from './get-treatment-plan.use-case';
import {
  TreatmentPlan,
  TreatmentPlanWithItems,
} from '../../domain/entities/treatment-plan.entity';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';
import { TreatmentPlanRepository } from '../../domain/ports/treatment-plan-repository.port';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';

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

describe('GetTreatmentPlanUseCase', () => {
  it('throws NotFoundException when the repository returns null (absent or another tenant)', async () => {
    const repo = makeRepo({
      findPlanById: (): Promise<TreatmentPlanWithItems | null> =>
        Promise.resolve(null),
    });
    const uc = new GetTreatmentPlanUseCase(repo);

    await expect(uc.execute('missing-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('computes total as the sum of active items prices (canned repo result)', async () => {
    const plan: TreatmentPlanWithItems = {
      id: 'plan1',
      tenantId: 't1',
      patientId: 'p1',
      status: TreatmentPlanStatus.DRAFT,
      notes: null,
      createdById: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      items: [
        {
          id: 'item1',
          tenantId: 't1',
          planId: 'plan1',
          toothNumber: '11',
          surfaces: [],
          catalogItemId: 'cat1',
          price: 100,
          status: TreatmentPlanItemStatus.PROPOSED,
          notes: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: 'item2',
          tenantId: 't1',
          planId: 'plan1',
          toothNumber: '12',
          surfaces: [],
          catalogItemId: 'cat2',
          price: 50.5,
          status: TreatmentPlanItemStatus.PROPOSED,
          notes: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    };
    const repo = makeRepo({
      findPlanById: (): Promise<TreatmentPlanWithItems | null> =>
        Promise.resolve(plan),
    });
    const uc = new GetTreatmentPlanUseCase(repo);

    const result = await uc.execute('plan1');

    expect(result.total).toBe(150.5);
    expect(result.items).toHaveLength(2);
  });

  it('returns total 0 for a plan with no items', async () => {
    const plan: TreatmentPlanWithItems = {
      id: 'plan1',
      tenantId: 't1',
      patientId: 'p1',
      status: TreatmentPlanStatus.DRAFT,
      notes: null,
      createdById: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      items: [],
    };
    const repo = makeRepo({
      findPlanById: (): Promise<TreatmentPlanWithItems | null> =>
        Promise.resolve(plan),
    });
    const uc = new GetTreatmentPlanUseCase(repo);

    const result = await uc.execute('plan1');

    expect(result.total).toBe(0);
  });

  // Real in-memory filtering — proves a soft-deleted item is excluded from
  // BOTH the items list and the total, not just hidden by a canned stub.
  describe('soft-deleted items (real in-memory filtering)', () => {
    it('excludes a soft-deleted item from items and from the computed total', async () => {
      const repo = new InMemoryTreatmentPlanRepository();
      const plan = repo.seedPlan({ patientId: 'p1' });
      repo.seedItem({ planId: plan.id, price: 100 });
      repo.seedItem({
        planId: plan.id,
        price: 999,
        deletedAt: new Date('2026-01-02T00:00:00.000Z'),
      });
      const uc = new GetTreatmentPlanUseCase(repo);

      const result = await uc.execute(plan.id);

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(100);
    });

    it('total drops after an item is soft-deleted via the repository directly', async () => {
      const repo = new InMemoryTreatmentPlanRepository();
      const plan = repo.seedPlan({ patientId: 'p1' });
      repo.seedItem({ planId: plan.id, price: 100 });
      const toRemove = repo.seedItem({ planId: plan.id, price: 200 });
      const uc = new GetTreatmentPlanUseCase(repo);

      const before = await uc.execute(plan.id);
      expect(before.total).toBe(300);

      await repo.softDeleteItem(toRemove.id);

      const after = await uc.execute(plan.id);
      expect(after.total).toBe(100);
      expect(after.items.map((i) => i.id)).not.toContain(toRemove.id);
    });
  });
});
