import { TreatmentPlanStatus } from '@prisma/client';
import { ListTreatmentPlansUseCase } from './list-treatment-plans.use-case';
import {
  TreatmentPlan,
  TreatmentPlanWithItems,
} from '../../domain/entities/treatment-plan.entity';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';
import { TreatmentPlanRepository } from '../../domain/ports/treatment-plan-repository.port';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';

function fakePlan(overrides: Partial<TreatmentPlan> = {}): TreatmentPlan {
  return {
    id: 'plan1',
    tenantId: 't1',
    patientId: 'p1',
    status: TreatmentPlanStatus.DRAFT,
    notes: null,
    createdById: null,
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

describe('ListTreatmentPlansUseCase', () => {
  it('forwards patientId to the repository and returns its result untouched (createdAt DESC is the repo contract)', async () => {
    const p1 = fakePlan({ id: 'plan1' });
    const p2 = fakePlan({ id: 'plan2' });
    let received: string | undefined;
    const repo = makeRepo({
      listPlansByPatient: (patientId: string): Promise<TreatmentPlan[]> => {
        received = patientId;
        return Promise.resolve([p2, p1]);
      },
    });
    const uc = new ListTreatmentPlansUseCase(repo);

    const result = await uc.execute('p1');

    expect(received).toBe('p1');
    expect(result).toEqual([p2, p1]);
  });

  it('only returns active plans for the patient, ordered createdAt DESC (real in-memory filtering)', async () => {
    const repo = new InMemoryTreatmentPlanRepository();
    const older = repo.seedPlan({
      patientId: 'p1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = repo.seedPlan({
      patientId: 'p1',
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    repo.seedPlan({
      patientId: 'p1',
      deletedAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    repo.seedPlan({ patientId: 'other-patient' });
    const uc = new ListTreatmentPlansUseCase(repo);

    const result = await uc.execute('p1');

    expect(result.map((p) => p.id)).toEqual([newer.id, older.id]);
  });
});
