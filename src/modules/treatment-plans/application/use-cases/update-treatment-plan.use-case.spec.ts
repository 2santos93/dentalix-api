import { NotFoundException } from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import { UpdateTreatmentPlanUseCase } from './update-treatment-plan.use-case';
import {
  TreatmentPlan,
  TreatmentPlanWithItems,
} from '../../domain/entities/treatment-plan.entity';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';
import {
  TreatmentPlanRepository,
  UpdateTreatmentPlanRepoInput,
} from '../../domain/ports/treatment-plan-repository.port';

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

describe('UpdateTreatmentPlanUseCase', () => {
  it('throws NotFoundException when the plan does not exist (or belongs to another tenant)', async () => {
    const repo = makeRepo({
      findPlanById: (): Promise<TreatmentPlanWithItems | null> =>
        Promise.resolve(null),
      updatePlan: (): Promise<TreatmentPlan> =>
        Promise.reject(new Error('updatePlan should not be called')),
    });
    const uc = new UpdateTreatmentPlanUseCase(repo);

    await expect(
      uc.execute('missing-id', { status: TreatmentPlanStatus.ACCEPTED }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    TreatmentPlanStatus.DRAFT,
    TreatmentPlanStatus.ACCEPTED,
    TreatmentPlanStatus.COMPLETED,
    TreatmentPlanStatus.CANCELLED,
  ])('allows changing status to %s', async (status) => {
    const existing = fakePlanWithItems();
    const updated = { ...existing, status };
    let receivedPatch: UpdateTreatmentPlanRepoInput | undefined;
    const repo = makeRepo({
      findPlanById: (id: string): Promise<TreatmentPlanWithItems | null> =>
        Promise.resolve(id === existing.id ? existing : null),
      updatePlan: (
        _id: string,
        patch: UpdateTreatmentPlanRepoInput,
      ): Promise<TreatmentPlan> => {
        receivedPatch = patch;
        return Promise.resolve(updated);
      },
    });
    const uc = new UpdateTreatmentPlanUseCase(repo);

    const result = await uc.execute(existing.id, { status });

    expect(result.status).toBe(status);
    expect(receivedPatch).toEqual({ status });
  });

  it('allows changing notes', async () => {
    const existing = fakePlanWithItems();
    let receivedPatch: UpdateTreatmentPlanRepoInput | undefined;
    const repo = makeRepo({
      findPlanById: (id: string): Promise<TreatmentPlanWithItems | null> =>
        Promise.resolve(id === existing.id ? existing : null),
      updatePlan: (
        _id: string,
        patch: UpdateTreatmentPlanRepoInput,
      ): Promise<TreatmentPlan> => {
        receivedPatch = patch;
        return Promise.resolve({ ...existing, notes: patch.notes ?? null });
      },
    });
    const uc = new UpdateTreatmentPlanUseCase(repo);

    const result = await uc.execute(existing.id, { notes: 'Nueva nota' });

    expect(result.notes).toBe('Nueva nota');
    expect(receivedPatch).toEqual({ notes: 'Nueva nota' });
  });
});
