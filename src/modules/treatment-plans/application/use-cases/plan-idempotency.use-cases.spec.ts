import { CatalogKind, TreatmentPlanStatus } from '@prisma/client';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
import {
  DENTIST_ACTOR,
  FIXED_CLOCK,
  testDiscountPolicy,
} from './__fixtures__/discount-fixtures';
import {
  InMemoryTreatmentPlanRepository,
  planCurrencySource,
} from './__fixtures__/in-memory-treatment-plan.repository';
import { catalogPricing } from './__fixtures__/catalog-pricing-source';
import { AddTreatmentPlanItemUseCase } from './add-treatment-plan-item.use-case';
import { CreateTreatmentPlanUseCase } from './create-treatment-plan.use-case';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogItem } from '../../../dental-catalog/domain/entities/dental-catalog-item.entity';

const KEY = '3e2d1c0b-9a8f-4e7d-b6c5-a4b3c2d1e0f9';

const RESINA = {
  id: 'resina',
  kind: CatalogKind.PROCEDURE,
  defaultPrice: 45,
  allowDiscount: true,
} as DentalCatalogItem;

const catalog = {
  findById: (id: string) => Promise.resolve({ ...RESINA, id }),
  findByIds: (ids: string[]) =>
    Promise.resolve(ids.map((id) => ({ ...RESINA, id }))),
} as unknown as DentalCatalogRepository;

function setup() {
  const repo = new InMemoryTreatmentPlanRepository();
  repo.seedPlan({
    id: 'plan1',
    status: TreatmentPlanStatus.DRAFT,
    currency: 'USD',
  });
  const add = new AddTreatmentPlanItemUseCase(
    repo,
    catalogPricing(catalog),
    testDiscountPolicy(),
    FIXED_CLOCK,
  );
  const create = new CreateTreatmentPlanUseCase(
    repo,
    { has: () => Promise.resolve(true) },
    patientsInClinic('p1', 'p2'),
    planCurrencySource({
      kind: 'location',
      locationId: 'loc-1',
      currency: 'USD',
    }),
  );
  return { repo, add, create };
}

const ITEM = {
  toothNumber: '36',
  catalogItemId: 'resina',
  notes: 'Caries oclusal',
};

describe('Idempotency-Key del plan y de sus ítems (DX-574)', () => {
  it('repetir el alta del ítem con la misma clave no añade otro', async () => {
    const { add, repo } = setup();
    const first = await add.execute('plan1', ITEM, DENTIST_ACTOR, {
      idempotencyKey: KEY,
    });
    const signals: { replayed?: boolean } = {};
    const again = await add.execute('plan1', { ...ITEM }, DENTIST_ACTOR, {
      idempotencyKey: KEY,
      signals,
    });

    expect(again.id).toBe(first.id);
    expect(signals.replayed).toBe(true);
    expect((await repo.findPlanById('plan1'))!.items).toHaveLength(1);
  });

  it('la misma clave con otro diente es un 422', async () => {
    const { add, repo } = setup();
    await add.execute('plan1', ITEM, DENTIST_ACTOR, { idempotencyKey: KEY });

    await expect(
      add.execute('plan1', { ...ITEM, toothNumber: '46' }, DENTIST_ACTOR, {
        idempotencyKey: KEY,
      }),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    expect((await repo.findPlanById('plan1'))!.items).toHaveLength(1);
  });

  it('repetir el alta del plan con la misma clave no crea otro borrador', async () => {
    const { create } = setup();
    const first = await create.execute(
      { patientId: 'p1', createdById: 'u1' },
      { idempotencyKey: KEY },
    );
    const again = await create.execute(
      { patientId: 'p1', createdById: 'u1' },
      { idempotencyKey: KEY },
    );
    expect(again.id).toBe(first.id);
  });

  it('la clave del plan usada para otro paciente es un 422', async () => {
    const { create } = setup();
    await create.execute({ patientId: 'p1' }, { idempotencyKey: KEY });
    await expect(
      create.execute({ patientId: 'p2' }, { idempotencyKey: KEY }),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });
});
