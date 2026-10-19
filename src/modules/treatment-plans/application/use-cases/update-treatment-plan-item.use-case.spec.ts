import {
  ADMIN_ACTOR,
  FIXED_CLOCK,
  testDiscountPolicy,
} from './__fixtures__/discount-fixtures';
import { NotFoundException } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  ToothSurface,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import { UpdateTreatmentPlanItemUseCase } from './update-treatment-plan-item.use-case';
import {
  TreatmentPlan,
  TreatmentPlanWithItems,
} from '../../domain/entities/treatment-plan.entity';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';
import {
  DecideItemChange,
  DoneMirrorInput,
  TreatmentPlanRepository,
  UpdateTreatmentPlanItemRepoInput,
} from '../../domain/ports/treatment-plan-repository.port';
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
    catalogPrice: null,
    price: 200,
    discount: 0,
    discountReason: null,
    discountReasonNote: null,
    discountById: null,
    discountAt: null,
    discountLocationId: null,
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
    applyBulkDiscount: (): Promise<TreatmentPlanItem[]> =>
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
    list: (): Promise<DentalCatalogItem[]> => Promise.resolve([]),
    listDirectory: () =>
      Promise.reject(new Error('not implemented in this fake')),
    findById: (): Promise<DentalCatalogItem | null> => Promise.resolve(null),
    update: (): Promise<DentalCatalogItem> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

// Minimal open plan: the use case reads `patientId`, `status` and `acceptance`.
const planWithPatient = {
  patientId: 'pat1',
  status: TreatmentPlanStatus.DRAFT,
  acceptance: null,
  items: [],
} as unknown as TreatmentPlanWithItems;

/**
 * `updateItem` del fake con el contrato real (BE-036): `decide` recibe el plan
 * y el ítem releídos en la transacción y el fake escribe lo decidido.
 */
function applying(
  existing: TreatmentPlanItem,
  write: (
    patch: UpdateTreatmentPlanItemRepoInput,
    mirror?: DoneMirrorInput,
  ) => Promise<TreatmentPlanItem>,
): TreatmentPlanRepository['updateItem'] {
  return (_id: string, decide: DecideItemChange) => {
    try {
      const { patch, mirror } = decide({
        plan: planWithPatient,
        item: existing,
      });
      return write(patch, mirror);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
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
    const uc = new UpdateTreatmentPlanItemUseCase(
      repo,
      makeCatalogRepo(),
      testDiscountPolicy(),
      FIXED_CLOCK,
    );

    await expect(
      uc.execute('missing-id', { price: 100 }, ADMIN_ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('changes price', async () => {
    const existing = fakeItem();
    let receivedPatch: UpdateTreatmentPlanItemRepoInput | undefined;
    const repo = makeRepo({
      findItemById: (id: string): Promise<TreatmentPlanItem | null> =>
        Promise.resolve(id === existing.id ? existing : null),
      updateItem: applying(existing, (patch) => {
        receivedPatch = patch;
        return Promise.resolve({
          ...existing,
          price: patch.price ?? existing.price,
        });
      }),
    });
    const uc = new UpdateTreatmentPlanItemUseCase(
      repo,
      makeCatalogRepo(),
      testDiscountPolicy(),
      FIXED_CLOCK,
    );

    const result = await uc.execute(existing.id, { price: 999 }, ADMIN_ACTOR);

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
      makeCatalogRepo(),
      testDiscountPolicy(),
      FIXED_CLOCK,
    );

    const result = await uc.execute(existing.id, { status }, ADMIN_ACTOR);

    expect(result.status).toBe(status);
  });

  it('allows changing surfaces and notes', async () => {
    const existing = fakeItem();
    let receivedPatch: UpdateTreatmentPlanItemRepoInput | undefined;
    const repo = makeRepo({
      findItemById: (id: string): Promise<TreatmentPlanItem | null> =>
        Promise.resolve(id === existing.id ? existing : null),
      updateItem: applying(existing, (patch) => {
        receivedPatch = patch;
        return Promise.resolve({
          ...existing,
          surfaces: patch.surfaces ?? existing.surfaces,
          notes: patch.notes ?? existing.notes,
        });
      }),
    });
    const uc = new UpdateTreatmentPlanItemUseCase(
      repo,
      makeCatalogRepo(),
      testDiscountPolicy(),
      FIXED_CLOCK,
    );

    const result = await uc.execute(
      existing.id,
      {
        surfaces: [ToothSurface.DISTAL],
        notes: 'Actualizado',
      },
      ADMIN_ACTOR,
    );

    expect(result.surfaces).toEqual([ToothSurface.DISTAL]);
    expect(result.notes).toBe('Actualizado');
    expect(receivedPatch).toEqual({
      surfaces: [ToothSurface.DISTAL],
      notes: 'Actualizado',
    });
  });

  // DX-042 (DB-013): la transición a DONE y su registro en el odontograma van
  // en UNA transacción del repositorio (con el ítem bloqueado), así que el caso
  // de uso solo resuelve los datos del espejo y se los pasa a `updateItem`.
  describe('Pieza B — mirror to odontogram on DONE', () => {
    function capture(existing: TreatmentPlanItem) {
      const calls: {
        patch: UpdateTreatmentPlanItemRepoInput;
        mirror: DoneMirrorInput | undefined;
      }[] = [];
      const repo = makeRepo({
        findItemById: (): Promise<TreatmentPlanItem | null> =>
          Promise.resolve(existing),
        updateItem: applying(existing, (patch, mirror) => {
          calls.push({ patch, mirror });
          return Promise.resolve({
            ...existing,
            status: patch.status ?? existing.status,
          });
        }),
        findPlanById: (): Promise<TreatmentPlanWithItems | null> =>
          Promise.resolve(planWithPatient),
      });
      return { repo, calls };
    }

    it('asks the repository to mirror the item when it transitions to DONE', async () => {
      const existing = fakeItem({ status: TreatmentPlanItemStatus.PROPOSED });
      const { repo, calls } = capture(existing);
      const catalog = makeCatalogRepo({
        findById: (): Promise<DentalCatalogItem | null> =>
          Promise.resolve({ kind: CatalogKind.DIAGNOSIS } as DentalCatalogItem),
      });
      const uc = new UpdateTreatmentPlanItemUseCase(
        repo,
        catalog,
        testDiscountPolicy(),
        FIXED_CLOCK,
      );

      const result = await uc.execute(
        existing.id,
        { status: TreatmentPlanItemStatus.DONE },
        { userId: 'user1', role: ClinicRole.ADMIN },
      );

      expect(result.status).toBe(TreatmentPlanItemStatus.DONE);
      expect(calls).toEqual([
        {
          patch: { status: TreatmentPlanItemStatus.DONE },
          mirror: {
            patientId: 'pat1',
            kind: CatalogKind.DIAGNOSIS,
            performedById: 'user1',
          },
        },
      ]);
    });

    it('defaults the record kind to PROCEDURE when the catalog item is gone', async () => {
      const { repo, calls } = capture(fakeItem());
      const uc = new UpdateTreatmentPlanItemUseCase(
        repo,
        makeCatalogRepo(),
        testDiscountPolicy(),
        FIXED_CLOCK,
      );

      await uc.execute(
        'item1',
        { status: TreatmentPlanItemStatus.DONE },
        ADMIN_ACTOR,
      );

      expect(calls[0].mirror).toEqual({
        patientId: 'pat1',
        kind: CatalogKind.PROCEDURE,
        performedById: ADMIN_ACTOR.userId,
      });
    });

    it('does not ask for a mirror when the item was already DONE (no transition)', async () => {
      const { repo, calls } = capture(
        fakeItem({ status: TreatmentPlanItemStatus.DONE }),
      );
      const uc = new UpdateTreatmentPlanItemUseCase(
        repo,
        makeCatalogRepo(),
        testDiscountPolicy(),
        FIXED_CLOCK,
      );

      await uc.execute(
        'item1',
        { status: TreatmentPlanItemStatus.DONE },
        ADMIN_ACTOR,
      );

      expect(calls[0].mirror).toBeUndefined();
    });

    it('does not ask for a mirror on a patch that does not touch the status', async () => {
      const { repo, calls } = capture(fakeItem());
      const uc = new UpdateTreatmentPlanItemUseCase(
        repo,
        makeCatalogRepo(),
        testDiscountPolicy(),
        FIXED_CLOCK,
      );

      await uc.execute('item1', { price: 300 }, ADMIN_ACTOR);

      expect(calls[0].mirror).toBeUndefined();
    });

    it('fails as a whole if the mirror cannot be written (never DONE without its record)', async () => {
      const existing = fakeItem();
      const repo = makeRepo({
        findItemById: (): Promise<TreatmentPlanItem | null> =>
          Promise.resolve(existing),
        findPlanById: (): Promise<TreatmentPlanWithItems | null> =>
          Promise.resolve(planWithPatient),
        updateItem: (): Promise<TreatmentPlanItem> =>
          Promise.reject(new Error('odontogram write failed')),
      });
      const uc = new UpdateTreatmentPlanItemUseCase(
        repo,
        makeCatalogRepo(),
        testDiscountPolicy(),
        FIXED_CLOCK,
      );

      await expect(
        uc.execute(
          existing.id,
          { status: TreatmentPlanItemStatus.DONE },
          ADMIN_ACTOR,
        ),
      ).rejects.toThrow('odontogram write failed');
    });
  });
});
