import { BadRequestException } from '@nestjs/common';
import { CatalogKind } from '@prisma/client';
import { CreateCatalogItemUseCase } from './create-catalog-item.use-case';
import { DentalCatalogItem } from '../../domain/entities/dental-catalog-item.entity';
import {
  CreateDentalCatalogItemRepoInput,
  DentalCatalogRepository,
} from '../../domain/ports/dental-catalog-repository.port';

function fakeItemFrom(
  id: string,
  input: CreateDentalCatalogItemRepoInput,
  tenantId = 't1',
): DentalCatalogItem {
  return {
    id,
    tenantId,
    code: input.code,
    category: input.category ?? null,
    kind: input.kind,
    labelEs: input.labelEs,
    labelEn: input.labelEn ?? null,
    labelPt: input.labelPt ?? null,
    color: input.color,
    defaultPrice: input.defaultPrice ?? null,
    active: input.active ?? true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function makeRepo(
  overrides: Partial<DentalCatalogRepository> = {},
): DentalCatalogRepository {
  return {
    create: (input: CreateDentalCatalogItemRepoInput) =>
      Promise.resolve(fakeItemFrom('c1', input)),
    findById: (): Promise<DentalCatalogItem | null> => Promise.resolve(null),
    list: (): Promise<DentalCatalogItem[]> => Promise.resolve([]),
    update: (): Promise<DentalCatalogItem> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

describe('CreateCatalogItemUseCase', () => {
  it('creates a catalog item and returns the mapped entity', async () => {
    const repo = makeRepo();
    const uc = new CreateCatalogItemUseCase(repo);

    const result = await uc.execute({
      code: 'CAR-001',
      kind: CatalogKind.DIAGNOSIS,
      labelEs: 'Caries',
      color: '#FF0000',
    });

    expect(result.id).toBe('c1');
    expect(result.code).toBe('CAR-001');
    expect(result.kind).toBe(CatalogKind.DIAGNOSIS);
    expect(result.color).toBe('#FF0000');
  });

  it('normalizes code (trim) before persisting', async () => {
    let captured: CreateDentalCatalogItemRepoInput | undefined;
    const repo = makeRepo({
      create: (input) => {
        captured = input;
        return Promise.resolve(fakeItemFrom('c2', input));
      },
    });
    const uc = new CreateCatalogItemUseCase(repo);

    await uc.execute({
      code: '  CAR-002  ',
      kind: CatalogKind.PROCEDURE,
      labelEs: 'Obturacion',
      color: '#00FF00',
    });

    expect(captured?.code).toBe('CAR-002');
  });

  it.each(['red', '#GGG', '123456', '#12', '#1234567890', ''])(
    'rejects an invalid hex color (%s)',
    async (color) => {
      const repo = makeRepo();
      const uc = new CreateCatalogItemUseCase(repo);

      await expect(
        uc.execute({
          code: 'CAR-003',
          kind: CatalogKind.DIAGNOSIS,
          labelEs: 'Caries',
          color,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each(['#FFF', '#FFFF', '#FFFFFF', '#FFFFFFFF', '#000'])(
    'accepts a valid hex color (%s)',
    async (color) => {
      const repo = makeRepo();
      const uc = new CreateCatalogItemUseCase(repo);

      const result = await uc.execute({
        code: 'CAR-004',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Limpieza',
        color,
      });

      expect(result.color).toBe(color);
    },
  );

  it('rejects a kind that is not a valid CatalogKind enum value', async () => {
    const repo = makeRepo();
    const uc = new CreateCatalogItemUseCase(repo);

    // Bypass the type system deliberately: prove the use case validates at
    // runtime even though CreateCatalogItemInput['kind'] is typed as
    // CatalogKind for every legitimate caller.
    const maliciousInput = {
      code: 'CAR-005',
      kind: 'NOT_A_KIND',
      labelEs: 'Caries',
      color: '#FFFFFF',
    } as unknown as Parameters<typeof uc.execute>[0];

    await expect(uc.execute(maliciousInput)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('never forwards a tenantId sneaked into the input to the repository (tenant comes from context, not input)', async () => {
    let captured:
      (CreateDentalCatalogItemRepoInput & { tenantId?: string }) | undefined;
    const repo = makeRepo({
      create: (input) => {
        captured = input;
        return Promise.resolve(fakeItemFrom('c6', input));
      },
    });
    const uc = new CreateCatalogItemUseCase(repo);

    const maliciousInput = {
      code: 'CAR-006',
      kind: CatalogKind.DIAGNOSIS,
      labelEs: 'Caries',
      color: '#ABCDEF',
      tenantId: 'sneaky-tenant',
    } as unknown as Parameters<typeof uc.execute>[0];

    const result = await uc.execute(maliciousInput);

    expect(captured && 'tenantId' in captured).toBe(false);
    expect(result.tenantId).toBe('t1'); // comes from the repo/context, not input
  });

  it('passes optional fields (category, i18n labels, defaultPrice, active) through untouched', async () => {
    let captured: CreateDentalCatalogItemRepoInput | undefined;
    const repo = makeRepo({
      create: (input) => {
        captured = input;
        return Promise.resolve(fakeItemFrom('c7', input));
      },
    });
    const uc = new CreateCatalogItemUseCase(repo);

    await uc.execute({
      code: 'CAR-007',
      category: 'Restaurativa',
      kind: CatalogKind.PROCEDURE,
      labelEs: 'Obturacion',
      labelEn: 'Filling',
      labelPt: 'Obturacao',
      color: '#123ABC',
      defaultPrice: 45000,
      active: false,
    });

    expect(captured).toMatchObject({
      category: 'Restaurativa',
      labelEn: 'Filling',
      labelPt: 'Obturacao',
      defaultPrice: 45000,
      active: false,
    });
  });
});
