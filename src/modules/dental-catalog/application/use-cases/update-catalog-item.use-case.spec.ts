import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CatalogKind } from '@prisma/client';
import { UpdateCatalogItemUseCase } from './update-catalog-item.use-case';
import { DentalCatalogItem } from '../../domain/entities/dental-catalog-item.entity';
import {
  CreateDentalCatalogItemRepoInput,
  DentalCatalogRepository,
  UpdateDentalCatalogItemRepoInput,
} from '../../domain/ports/dental-catalog-repository.port';

function fakeItem(
  overrides: Partial<DentalCatalogItem> = {},
): DentalCatalogItem {
  return {
    id: 'c1',
    tenantId: 't1',
    code: 'CAR-001',
    category: null,
    kind: CatalogKind.DIAGNOSIS,
    labelEs: 'Caries',
    labelEn: null,
    labelPt: null,
    color: '#FF0000',
    defaultPrice: null,
    cupsCode: null,
    allowDiscount: true,
    active: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<DentalCatalogRepository> = {},
): DentalCatalogRepository {
  return {
    create: (input: CreateDentalCatalogItemRepoInput) =>
      Promise.reject(
        new Error(
          `not implemented in this fake: create(${JSON.stringify(input)})`,
        ),
      ),
    findById: (): Promise<DentalCatalogItem | null> => Promise.resolve(null),
    list: (): Promise<DentalCatalogItem[]> => Promise.resolve([]),
    findByIds: () => Promise.resolve([]),
    listDirectory: () =>
      Promise.reject(new Error('not implemented in this fake')),
    update: (): Promise<DentalCatalogItem> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

describe('UpdateCatalogItemUseCase', () => {
  it('updates fields and returns the updated entity', async () => {
    const existing = fakeItem();
    const updated = fakeItem({ labelEs: 'Caries profunda', active: false });
    let receivedId: string | undefined;
    let receivedPatch: UpdateDentalCatalogItemRepoInput | undefined;
    const repo = makeRepo({
      findById: (id: string) =>
        Promise.resolve(id === existing.id ? existing : null),
      update: (id: string, patch: UpdateDentalCatalogItemRepoInput) => {
        receivedId = id;
        receivedPatch = patch;
        return Promise.resolve(updated);
      },
    });
    const uc = new UpdateCatalogItemUseCase(repo);

    const result = await uc.execute(existing.id, {
      labelEs: 'Caries profunda',
      active: false,
    });

    expect(result).toBe(updated);
    expect(receivedId).toBe(existing.id);
    expect(receivedPatch).toEqual({
      labelEs: 'Caries profunda',
      active: false,
    });
  });

  it('throws NotFoundException when the item does not exist (or belongs to another tenant)', async () => {
    const repo = makeRepo({
      findById: () => Promise.resolve(null),
      update: () => Promise.reject(new Error('update should not be called')),
    });
    const uc = new UpdateCatalogItemUseCase(repo);

    await expect(
      uc.execute('missing-id', { active: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an invalid hex color in the patch', async () => {
    const existing = fakeItem();
    const repo = makeRepo({
      findById: (id: string) =>
        Promise.resolve(id === existing.id ? existing : null),
      update: () => Promise.reject(new Error('update should not be called')),
    });
    const uc = new UpdateCatalogItemUseCase(repo);

    await expect(
      uc.execute(existing.id, { color: 'not-a-color' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid kind in the patch', async () => {
    const existing = fakeItem();
    const repo = makeRepo({
      findById: (id: string) =>
        Promise.resolve(id === existing.id ? existing : null),
      update: () => Promise.reject(new Error('update should not be called')),
    });
    const uc = new UpdateCatalogItemUseCase(repo);

    const maliciousPatch = {
      kind: 'NOT_A_KIND',
    } as unknown as Parameters<typeof uc.execute>[1];

    await expect(
      uc.execute(existing.id, maliciousPatch),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows a patch without color/kind to pass through untouched', async () => {
    const existing = fakeItem();
    let receivedPatch: UpdateDentalCatalogItemRepoInput | undefined;
    const repo = makeRepo({
      findById: (id: string) =>
        Promise.resolve(id === existing.id ? existing : null),
      update: (_id: string, patch: UpdateDentalCatalogItemRepoInput) => {
        receivedPatch = patch;
        return Promise.resolve(fakeItem({ category: 'X' }));
      },
    });
    const uc = new UpdateCatalogItemUseCase(repo);

    await uc.execute(existing.id, { category: 'X' });

    expect(receivedPatch).toEqual({ category: 'X' });
  });

  it('normalizes code (trim) in the patch when present', async () => {
    const existing = fakeItem();
    let receivedPatch: UpdateDentalCatalogItemRepoInput | undefined;
    const repo = makeRepo({
      findById: (id: string) =>
        Promise.resolve(id === existing.id ? existing : null),
      update: (_id: string, patch: UpdateDentalCatalogItemRepoInput) => {
        receivedPatch = patch;
        return Promise.resolve(fakeItem({ code: 'CAR-002' }));
      },
    });
    const uc = new UpdateCatalogItemUseCase(repo);

    await uc.execute(existing.id, { code: '  CAR-002  ' });

    expect(receivedPatch?.code).toBe('CAR-002');
  });
});

describe('UpdateCatalogItemUseCase · CUPS (DX-212)', () => {
  function capture() {
    let received: UpdateDentalCatalogItemRepoInput | undefined;
    const repo = makeRepo({
      findById: () => Promise.resolve(fakeItem()),
      update: (_id: string, patch: UpdateDentalCatalogItemRepoInput) => {
        received = patch;
        return Promise.resolve(fakeItem({ cupsCode: patch.cupsCode ?? null }));
      },
    });
    return { uc: new UpdateCatalogItemUseCase(repo), patch: () => received };
  }

  it('guarda el CUPS normalizado (mayúsculas, sin espacios)', async () => {
    const { uc, patch } = capture();
    await uc.execute('c1', { cupsCode: ' a1b2c3 ' });
    expect(patch()?.cupsCode).toBe('A1B2C3');
  });

  it('vacío o null quita el código', async () => {
    const { uc, patch } = capture();
    await uc.execute('c1', { cupsCode: '' });
    expect(patch()?.cupsCode).toBeNull();
  });

  it('formato inválido: 400 con el formato esperado, sin escribir', async () => {
    const { uc, patch } = capture();
    await expect(uc.execute('c1', { cupsCode: '89-20' })).rejects.toThrow(
      new BadRequestException(
        'El código CUPS debe tener 6 caracteres alfanuméricos (p. ej. 890203)',
      ),
    );
    expect(patch()).toBeUndefined();
  });

  it('sin el campo, no lo toca', async () => {
    const { uc, patch } = capture();
    await uc.execute('c1', { labelEs: 'Caries' });
    expect(patch()).not.toHaveProperty('cupsCode');
  });
});

describe('UpdateCatalogItemUseCase · allowDiscount (DX-105)', () => {
  it('pasa allowDiscount al repositorio y devuelve la entidad actualizada', async () => {
    let received: UpdateDentalCatalogItemRepoInput | undefined;
    const repo = makeRepo({
      findById: () => Promise.resolve(fakeItem()),
      update: (_id: string, patch: UpdateDentalCatalogItemRepoInput) => {
        received = patch;
        return Promise.resolve(
          fakeItem({ allowDiscount: patch.allowDiscount ?? true }),
        );
      },
    });
    const uc = new UpdateCatalogItemUseCase(repo);

    const result = await uc.execute('c1', { allowDiscount: false });

    expect(received).toEqual({ allowDiscount: false });
    expect(result.allowDiscount).toBe(false);
  });
});
