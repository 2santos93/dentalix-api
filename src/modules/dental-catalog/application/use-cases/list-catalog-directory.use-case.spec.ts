import { CatalogKind } from '@prisma/client';
import { ListCatalogDirectoryUseCase } from './list-catalog-directory.use-case';
import type {
  CatalogDirectoryPage,
  DentalCatalogRepository,
  ListCatalogDirectoryParams,
} from '../../domain/ports/dental-catalog-repository.port';
import { DentalCatalogItem } from '../../domain/entities/dental-catalog-item.entity';

function fakeItem(code: string): DentalCatalogItem {
  return {
    id: `id-${code}`,
    tenantId: 't1',
    code,
    category: null,
    kind: CatalogKind.PROCEDURE,
    labelEs: `Procedimiento ${code}`,
    labelEn: null,
    labelPt: null,
    color: '#0E7490',
    defaultPrice: null,
    cupsCode: null,
    allowDiscount: true,
    active: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

/**
 * Espía del repositorio: guarda los params con los que se le llamó, que es lo
 * que de verdad prueba este caso de uso — la normalización de página y el
 * recorte de la búsqueda ocurren ANTES de tocar la base.
 */
function makeRepo(page: CatalogDirectoryPage = { items: [], total: 0 }) {
  const calls: ListCatalogDirectoryParams[] = [];
  const repo: DentalCatalogRepository = {
    create: () => Promise.reject(new Error('not implemented in this fake')),
    findById: () => Promise.resolve(null),
    list: () => Promise.resolve([]),
    findByIds: () => Promise.resolve([]),
    listDirectory: (params) => {
      calls.push(params);
      return Promise.resolve(page);
    },
    update: () => Promise.reject(new Error('not implemented in this fake')),
  };
  return { repo, calls };
}

describe('ListCatalogDirectoryUseCase', () => {
  it('sin parámetros pide la primera página con el tamaño por defecto', async () => {
    const { repo, calls } = makeRepo();
    await new ListCatalogDirectoryUseCase(repo).execute();

    expect(calls[0]).toMatchObject({ skip: 0, take: 20 });
  });

  it('traduce la página a skip/take', async () => {
    const { repo, calls } = makeRepo();
    await new ListCatalogDirectoryUseCase(repo).execute({
      page: 3,
      pageSize: 10,
    });

    expect(calls[0]).toMatchObject({ skip: 20, take: 10 });
  });

  it('acota pageSize al máximo: nadie se lleva la tabla entera pidiendo 5000', async () => {
    const { repo, calls } = makeRepo();
    await new ListCatalogDirectoryUseCase(repo).execute({ pageSize: 5000 });

    expect(calls[0].take).toBe(100);
  });

  it('normaliza página y tamaño inválidos en vez de propagar un skip negativo', async () => {
    const { repo, calls } = makeRepo();
    await new ListCatalogDirectoryUseCase(repo).execute({
      page: 0,
      pageSize: -4,
    });

    expect(calls[0]).toMatchObject({ skip: 0, take: 20 });
  });

  it('recorta la búsqueda y trata el texto en blanco como "sin búsqueda"', async () => {
    const { repo, calls } = makeRepo();
    const useCase = new ListCatalogDirectoryUseCase(repo);

    await useCase.execute({ query: '  endodoncia  ' });
    await useCase.execute({ query: '   ' });

    expect(calls[0].query).toBe('endodoncia');
    // En blanco -> `undefined`: si se pasara "   " la búsqueda no casaría con
    // nada y el catálogo parecería vacío.
    expect(calls[1].query).toBeUndefined();
  });

  it('pasa los filtros de tipo y activos tal cual', async () => {
    const { repo, calls } = makeRepo();
    await new ListCatalogDirectoryUseCase(repo).execute({
      kind: CatalogKind.DIAGNOSIS,
      activeOnly: true,
    });

    expect(calls[0]).toMatchObject({
      kind: CatalogKind.DIAGNOSIS,
      activeOnly: true,
    });
  });

  it('devuelve el total del repositorio junto a la página efectiva', async () => {
    const { repo } = makeRepo({ items: [fakeItem('P-01')], total: 137 });
    const out = await new ListCatalogDirectoryUseCase(repo).execute({
      page: 2,
      pageSize: 25,
    });

    expect(out).toEqual({
      items: [expect.objectContaining({ code: 'P-01' })],
      total: 137,
      page: 2,
      pageSize: 25,
    });
  });
});
