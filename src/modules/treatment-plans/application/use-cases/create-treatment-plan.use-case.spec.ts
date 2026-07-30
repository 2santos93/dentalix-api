import { BadRequestException } from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import { CreateTreatmentPlanUseCase } from './create-treatment-plan.use-case';
import {
  TreatmentPlan,
  TreatmentPlanWithItems,
} from '../../domain/entities/treatment-plan.entity';
import {
  CreateTreatmentPlanRepoInput,
  TreatmentPlanRepository,
} from '../../domain/ports/treatment-plan-repository.port';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';
import { CurrencyWhitelist } from '../../domain/ports/currency-whitelist.port';

function fakePlan(overrides: Partial<TreatmentPlan> = {}): TreatmentPlan {
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
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<TreatmentPlanRepository> = {},
): TreatmentPlanRepository {
  return {
    createPlan: (input: CreateTreatmentPlanRepoInput): Promise<TreatmentPlan> =>
      Promise.resolve(
        fakePlan({
          patientId: input.patientId,
          notes: input.notes ?? null,
          createdById: input.createdById ?? null,
        }),
      ),
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

// Fake whitelist: allows the codes actually exercised by this suite. `has`
// is case-sensitive here on purpose, to catch a regression where the use
// case forgets to `.toUpperCase()` BEFORE calling it.
function makeWhitelist(allowed: string[] = ['USD', 'COP']): CurrencyWhitelist {
  return {
    has: (code: string): Promise<boolean> =>
      Promise.resolve(allowed.includes(code)),
  };
}

describe('CreateTreatmentPlanUseCase', () => {
  it('creates a plan in DRAFT status and returns the mapped entity', async () => {
    const repo = makeRepo();
    const uc = new CreateTreatmentPlanUseCase(repo, makeWhitelist());

    const result = await uc.execute({ patientId: 'p1', createdById: 'u1' });

    expect(result.patientId).toBe('p1');
    expect(result.status).toBe(TreatmentPlanStatus.DRAFT);
    expect(result.createdById).toBe('u1');
  });

  it('passes notes through untouched', async () => {
    let captured: CreateTreatmentPlanRepoInput | undefined;
    const repo = makeRepo({
      createPlan: (
        input: CreateTreatmentPlanRepoInput,
      ): Promise<TreatmentPlan> => {
        captured = input;
        return Promise.resolve(fakePlan({ notes: input.notes ?? null }));
      },
    });
    const uc = new CreateTreatmentPlanUseCase(repo, makeWhitelist());

    await uc.execute({ patientId: 'p1', notes: 'Plan inicial' });

    expect(captured?.notes).toBe('Plan inicial');
  });

  it('never forwards a tenantId/status sneaked into the input to the repository', async () => {
    let captured: CreateTreatmentPlanRepoInput | undefined;
    const repo = makeRepo({
      createPlan: (
        input: CreateTreatmentPlanRepoInput,
      ): Promise<TreatmentPlan> => {
        captured = input;
        return Promise.resolve(fakePlan());
      },
    });
    const uc = new CreateTreatmentPlanUseCase(repo, makeWhitelist());

    const maliciousInput = {
      patientId: 'p1',
      tenantId: 'sneaky-tenant',
      status: TreatmentPlanStatus.COMPLETED,
    } as unknown as Parameters<typeof uc.execute>[0];

    await uc.execute(maliciousInput);

    expect(captured && 'tenantId' in captured).toBe(false);
    expect(captured && 'status' in captured).toBe(false);
  });

  it('defaults currency to USD, whitelist-validated, when omitted', async () => {
    let captured: CreateTreatmentPlanRepoInput | undefined;
    const repo = makeRepo({
      createPlan: (
        input: CreateTreatmentPlanRepoInput,
      ): Promise<TreatmentPlan> => {
        captured = input;
        return Promise.resolve(fakePlan({ currency: input.currency }));
      },
    });
    const uc = new CreateTreatmentPlanUseCase(repo, makeWhitelist());

    const result = await uc.execute({ patientId: 'p1' });

    expect(captured?.currency).toBe('USD');
    expect(result.currency).toBe('USD');
  });

  it('uppercases an explicit currency before whitelisting/forwarding it', async () => {
    let captured: CreateTreatmentPlanRepoInput | undefined;
    const repo = makeRepo({
      createPlan: (
        input: CreateTreatmentPlanRepoInput,
      ): Promise<TreatmentPlan> => {
        captured = input;
        return Promise.resolve(fakePlan({ currency: input.currency }));
      },
    });
    const uc = new CreateTreatmentPlanUseCase(repo, makeWhitelist());

    await uc.execute({ patientId: 'p1', currency: 'cop' });

    expect(captured?.currency).toBe('COP');
  });

  it('rejects an unknown currency with BadRequestException, without calling the repo', async () => {
    const repo = makeRepo({
      createPlan: (): Promise<TreatmentPlan> =>
        Promise.reject(new Error('createPlan should not be called')),
    });
    const uc = new CreateTreatmentPlanUseCase(repo, makeWhitelist());

    await expect(
      uc.execute({ patientId: 'p1', currency: 'XXX' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
