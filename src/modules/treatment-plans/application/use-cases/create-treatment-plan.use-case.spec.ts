import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
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
import {
  PLAN_WITHOUT_OPTIONS,
  planCurrencySource,
} from './__fixtures__/in-memory-treatment-plan.repository';

function fakePlan(overrides: Partial<TreatmentPlan> = {}): TreatmentPlan {
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
          ...PLAN_WITHOUT_OPTIONS,
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
    applyBulkDiscount: (): Promise<TreatmentPlanItem[]> =>
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

const LOC_COP = planCurrencySource({
  kind: 'location',
  locationId: 'loc-1',
  currency: 'COP',
});

describe('CreateTreatmentPlanUseCase', () => {
  it('creates a plan in DRAFT status and returns the mapped entity', async () => {
    const repo = makeRepo();
    const uc = new CreateTreatmentPlanUseCase(
      repo,
      makeWhitelist(),
      patientsInClinic('p1'),
      LOC_COP,
    );

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
    const uc = new CreateTreatmentPlanUseCase(
      repo,
      makeWhitelist(),
      patientsInClinic('p1'),
      LOC_COP,
    );

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
    const uc = new CreateTreatmentPlanUseCase(
      repo,
      makeWhitelist(),
      patientsInClinic('p1'),
      LOC_COP,
    );

    const maliciousInput = {
      patientId: 'p1',
      tenantId: 'sneaky-tenant',
      status: TreatmentPlanStatus.COMPLETED,
    } as unknown as Parameters<typeof uc.execute>[0];

    await uc.execute(maliciousInput);

    expect(captured && 'tenantId' in captured).toBe(false);
    expect(captured && 'status' in captured).toBe(false);
  });

  function makeUc(
    source: ReturnType<typeof planCurrencySource>,
    allowed = ['USD', 'COP', 'JPY'],
  ) {
    let captured: CreateTreatmentPlanRepoInput | undefined;
    const repo = makeRepo({
      createPlan: (
        input: CreateTreatmentPlanRepoInput,
      ): Promise<TreatmentPlan> => {
        captured = input;
        return Promise.resolve(fakePlan({ currency: input.currency }));
      },
    });
    const uc = new CreateTreatmentPlanUseCase(
      repo,
      makeWhitelist(allowed),
      patientsInClinic('p1'),
      source,
    );
    return { uc, captured: () => captured };
  }

  it('plan without currency at a JPY location is JPY', async () => {
    const { uc, captured } = makeUc(
      planCurrencySource({
        kind: 'location',
        locationId: 'loc-2',
        currency: 'JPY',
      }),
    );

    const result = await uc.execute({ patientId: 'p1' });

    expect(captured()?.currency).toBe('JPY');
    expect(result.currency).toBe('JPY');
  });

  it('no location and mixed currencies is 400 PLAN_CURRENCY_REQUIRED', async () => {
    const { uc, captured } = makeUc(
      planCurrencySource({
        kind: 'clinic',
        currencies: ['COP', 'JPY'],
        unconfigured: false,
      }),
    );

    const err = await uc.execute({ patientId: 'p1' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'PLAN_CURRENCY_REQUIRED',
      message:
        'Elige una sede o indica la moneda del plan: tus sedes usan monedas distintas.',
    });
    expect(captured()).toBeUndefined();
  });

  it('no location and a single currency uses it', async () => {
    const { uc, captured } = makeUc(
      planCurrencySource({
        kind: 'clinic',
        currencies: ['JPY'],
        unconfigured: false,
      }),
    );

    await uc.execute({ patientId: 'p1' });

    expect(captured()?.currency).toBe('JPY');
  });

  it('plan at a location with NULL currency is 409 LOCATION_CURRENCY_REQUIRED', async () => {
    const { uc, captured } = makeUc(
      planCurrencySource({
        kind: 'location',
        locationId: 'loc-9',
        currency: null,
      }),
    );

    const err = await uc.execute({ patientId: 'p1' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'LOCATION_CURRENCY_REQUIRED',
      locationId: 'loc-9',
    });
    expect(captured()).toBeUndefined();
  });

  it('no location and an unconfigured sede is 409, never a guess', async () => {
    const { uc } = makeUc(
      planCurrencySource({
        kind: 'clinic',
        currencies: ['COP'],
        unconfigured: true,
      }),
    );

    await expect(uc.execute({ patientId: 'p1' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('an explicit currency never consults the location', async () => {
    const context = jest.fn();
    const { uc, captured } = makeUc({ context });

    await uc.execute({ patientId: 'p1', currency: 'usd' });

    expect(captured()?.currency).toBe('USD');
    expect(context).not.toHaveBeenCalled();
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
    const uc = new CreateTreatmentPlanUseCase(
      repo,
      makeWhitelist(),
      patientsInClinic('p1'),
      LOC_COP,
    );

    await uc.execute({ patientId: 'p1', currency: 'cop' });

    expect(captured?.currency).toBe('COP');
  });

  it('rejects an unknown currency with BadRequestException, without calling the repo', async () => {
    const repo = makeRepo({
      createPlan: (): Promise<TreatmentPlan> =>
        Promise.reject(new Error('createPlan should not be called')),
    });
    const uc = new CreateTreatmentPlanUseCase(
      repo,
      makeWhitelist(),
      patientsInClinic('p1'),
      LOC_COP,
    );

    await expect(
      uc.execute({ patientId: 'p1', currency: 'XXX' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CreateTreatmentPlanUseCase — pertenencia del paciente (SEC-004)', () => {
  it('rechaza con 404 "Paciente no encontrado" un paciente que no es de la clínica, sin crear el plan', async () => {
    const createPlan = jest.fn();
    const repo = makeRepo({ createPlan });
    const uc = new CreateTreatmentPlanUseCase(
      repo,
      makeWhitelist(),
      patientsInClinic('p1'),
      LOC_COP,
    );

    await expect(uc.execute({ patientId: 'p-otra-clinica' })).rejects.toThrow(
      new NotFoundException('Paciente no encontrado'),
    );
    expect(createPlan).not.toHaveBeenCalled();
  });
});
