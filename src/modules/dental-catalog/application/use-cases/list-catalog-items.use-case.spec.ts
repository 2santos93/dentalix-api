import { CatalogKind } from '@prisma/client';
import { ListCatalogItemsUseCase } from './list-catalog-items.use-case';
import { DentalCatalogItem } from '../../domain/entities/dental-catalog-item.entity';
import {
  CreateDentalCatalogItemRepoInput,
  DentalCatalogRepository,
  ListDentalCatalogItemsParams,
} from '../../domain/ports/dental-catalog-repository.port';

function fakeItem(
  id: string,
  overrides: Partial<DentalCatalogItem> = {},
): DentalCatalogItem {
  return {
    id,
    tenantId: 't1',
    code: `CODE-${id}`,
    category: null,
    kind: CatalogKind.DIAGNOSIS,
    labelEs: 'Caries',
    labelEn: null,
    labelPt: null,
    color: '#FF0000',
    defaultPrice: null,
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
    update: (): Promise<DentalCatalogItem> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

describe('ListCatalogItemsUseCase', () => {
  it('passes the kind filter through to the repository unchanged', async () => {
    let captured: ListDentalCatalogItemsParams | undefined;
    const repo = makeRepo({
      list: (params) => {
        captured = params;
        return Promise.resolve([]);
      },
    });
    const uc = new ListCatalogItemsUseCase(repo);

    await uc.execute({ kind: CatalogKind.PROCEDURE });

    expect(captured?.kind).toBe(CatalogKind.PROCEDURE);
    expect(captured?.activeOnly).toBeUndefined();
  });

  it('passes the activeOnly filter through to the repository unchanged', async () => {
    let captured: ListDentalCatalogItemsParams | undefined;
    const repo = makeRepo({
      list: (params) => {
        captured = params;
        return Promise.resolve([]);
      },
    });
    const uc = new ListCatalogItemsUseCase(repo);

    await uc.execute({ activeOnly: true });

    expect(captured?.activeOnly).toBe(true);
    expect(captured?.kind).toBeUndefined();
  });

  it('passes both filters together', async () => {
    let captured: ListDentalCatalogItemsParams | undefined;
    const repo = makeRepo({
      list: (params) => {
        captured = params;
        return Promise.resolve([]);
      },
    });
    const uc = new ListCatalogItemsUseCase(repo);

    await uc.execute({ kind: CatalogKind.DIAGNOSIS, activeOnly: false });

    expect(captured).toEqual({
      kind: CatalogKind.DIAGNOSIS,
      activeOnly: false,
    });
  });

  it('calls the repository with no filters when none are provided', async () => {
    let captured: ListDentalCatalogItemsParams | undefined;
    const repo = makeRepo({
      list: (params) => {
        captured = params;
        return Promise.resolve([]);
      },
    });
    const uc = new ListCatalogItemsUseCase(repo);

    await uc.execute({});

    expect(captured?.kind).toBeUndefined();
    expect(captured?.activeOnly).toBeUndefined();
  });

  it('returns the items from the repository unchanged', async () => {
    const items = [
      fakeItem('1'),
      fakeItem('2', { kind: CatalogKind.PROCEDURE }),
    ];
    const repo = makeRepo({
      list: (): Promise<DentalCatalogItem[]> => Promise.resolve(items),
    });
    const uc = new ListCatalogItemsUseCase(repo);

    const result = await uc.execute({});

    expect(result).toBe(items);
  });
});
