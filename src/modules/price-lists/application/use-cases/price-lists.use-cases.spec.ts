import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InMemoryPriceListRepository } from '../__fixtures__/in-memory-price-lists';
import {
  CreatePriceListUseCase,
  DeletePriceListUseCase,
  ListPriceListItemsUseCase,
  ListPriceListsUseCase,
  PRICE_LIST_CURRENCY_LOCKED_MESSAGE,
  PRICE_LIST_DUPLICATE_MESSAGE,
  PRICE_LIST_IN_USE_MESSAGE,
  PRICE_LIST_LOCATION_TAKEN_MESSAGE,
  PRICE_LIST_NOT_FOUND_MESSAGE,
  ReplacePriceListItemsUseCase,
  UpdatePriceListUseCase,
} from './price-lists.use-cases';
import {
  PRICE_LIST_CATALOG_ITEMS_MESSAGE,
  PRICE_LIST_CURRENCY_UNKNOWN_MESSAGE,
  PRICE_LIST_DUPLICATED_ITEMS_MESSAGE,
  PRICE_LIST_LOCATION_NOT_FOUND_MESSAGE,
  PRICE_LIST_NAME_MESSAGE,
} from '../../domain/price-list-rules';
import type { CurrencyWhitelist } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';

const SEDE_NORTE = '11111111-1111-4111-8111-111111111111';
const SEDE_SUR = '22222222-2222-4222-8222-222222222222';

describe('casos de uso de listas de precios (DX-105)', () => {
  let repo: InMemoryPriceListRepository;
  let knownLocations: Set<string>;
  let knownCatalogIds: Set<string>;
  let whitelist: CurrencyWhitelist;
  let locations: LocationRepository;
  let catalog: DentalCatalogRepository;
  let list: ListPriceListsUseCase;
  let create: CreatePriceListUseCase;
  let update: UpdatePriceListUseCase;
  let remove: DeletePriceListUseCase;
  let listItems: ListPriceListItemsUseCase;
  let replace: ReplacePriceListItemsUseCase;

  beforeEach(() => {
    repo = new InMemoryPriceListRepository();
    knownLocations = new Set([SEDE_NORTE, SEDE_SUR]);
    knownCatalogIds = new Set(['c1', 'c2', 'c3']);
    whitelist = {
      has: (code) => Promise.resolve(['COP', 'USD', 'EUR'].includes(code)),
    };
    locations = {
      findById: (id: string) =>
        Promise.resolve(knownLocations.has(id) ? ({ id } as never) : null),
    } as unknown as LocationRepository;
    catalog = {
      findByIds: (ids: string[]) =>
        Promise.resolve(
          ids
            .filter((id) => knownCatalogIds.has(id))
            .map((id) => ({ id }) as never),
        ),
    } as unknown as DentalCatalogRepository;
    list = new ListPriceListsUseCase(repo);
    create = new CreatePriceListUseCase(repo, whitelist, locations);
    update = new UpdatePriceListUseCase(repo, whitelist, locations);
    remove = new DeletePriceListUseCase(repo);
    listItems = new ListPriceListItemsUseCase(repo);
    replace = new ReplacePriceListItemsUseCase(repo, catalog);
  });

  describe('listar', () => {
    it('por defecto solo las activas, por nombre; includeInactive suma las desactivadas y nunca las retiradas', async () => {
      repo.seed({ name: 'Sura' });
      repo.seed({ name: 'Allianz' });
      repo.seed({ name: 'Colsanitas', active: false });
      const retired = repo.seed({ name: 'Retirada' });
      repo.deleted.add(retired.id);

      expect((await list.execute({})).map((l) => l.name)).toEqual([
        'Allianz',
        'Sura',
      ]);
      expect(
        (await list.execute({ includeInactive: true })).map((l) => l.name),
      ).toEqual(['Allianz', 'Colsanitas', 'Sura']);
    });
  });

  describe('crear', () => {
    it('normaliza el nombre y la moneda y nace activa', async () => {
      const created = await create.execute(
        { name: '  Lista   Sura ', currency: 'cop' },
        'u1',
      );
      expect(created).toMatchObject({
        name: 'Lista Sura',
        currency: 'COP',
        locationId: null,
        active: true,
        itemCount: 0,
      });
    });

    it('400 con nombre corto', async () => {
      await expect(
        create.execute({ name: ' A ', currency: 'COP' }),
      ).rejects.toThrow(new BadRequestException(PRICE_LIST_NAME_MESSAGE));
    });

    it('400 con una moneda que no existe', async () => {
      await expect(
        create.execute({ name: 'Lista', currency: 'XXX' }),
      ).rejects.toThrow(
        new BadRequestException(PRICE_LIST_CURRENCY_UNKNOWN_MESSAGE),
      );
      expect(repo.rows).toHaveLength(0);
    });

    it('400 «Sede no encontrada.» si la sede no es de la clínica', async () => {
      await expect(
        create.execute({
          name: 'Lista',
          currency: 'COP',
          locationId: '33333333-3333-4333-8333-333333333333',
        }),
      ).rejects.toThrow(
        new BadRequestException(PRICE_LIST_LOCATION_NOT_FOUND_MESSAGE),
      );
    });

    it('409 si el nombre solo cambia en mayúsculas o tildes', async () => {
      repo.seed({ name: 'Convenio Bolívar' });
      await expect(
        create.execute({ name: ' CONVENIO  bolivar', currency: 'COP' }),
      ).rejects.toThrow(new ConflictException(PRICE_LIST_DUPLICATE_MESSAGE));
    });

    it('el nombre de una lista retirada vuelve a estar libre', async () => {
      const old = repo.seed({ name: 'Vieja' });
      repo.deleted.add(old.id);
      await expect(
        create.execute({ name: 'Vieja', currency: 'COP' }),
      ).resolves.toMatchObject({ name: 'Vieja' });
    });

    it('409 si la sede ya tiene una lista activa; con la otra desactivada, cabe', async () => {
      const taken = repo.seed({ name: 'Norte', locationId: SEDE_NORTE });
      await expect(
        create.execute({
          name: 'Otra Norte',
          currency: 'COP',
          locationId: SEDE_NORTE,
        }),
      ).rejects.toThrow(
        new ConflictException(PRICE_LIST_LOCATION_TAKEN_MESSAGE),
      );

      taken.active = false;
      await expect(
        create.execute({
          name: 'Otra Norte',
          currency: 'COP',
          locationId: SEDE_NORTE,
        }),
      ).resolves.toMatchObject({ locationId: SEDE_NORTE, active: true });
    });

    it('varias listas de clínica entera (sin sede) conviven', async () => {
      await create.execute({ name: 'Uno', currency: 'COP' });
      await expect(
        create.execute({ name: 'Dos', currency: 'COP' }),
      ).resolves.toMatchObject({ locationId: null });
    });
  });

  describe('editar', () => {
    it('404 si la lista no existe o está retirada', async () => {
      await expect(update.execute('nope', { name: 'Otro' })).rejects.toThrow(
        new NotFoundException(PRICE_LIST_NOT_FOUND_MESSAGE),
      );
      const retired = repo.seed();
      repo.deleted.add(retired.id);
      await expect(
        update.execute(retired.id, { name: 'Otro' }),
      ).rejects.toThrow(new NotFoundException(PRICE_LIST_NOT_FOUND_MESSAGE));
    });

    it('renombra; el propio nombre con otras mayúsculas no es duplicado', async () => {
      const row = repo.seed({ name: 'Sura' });
      await expect(
        update.execute(row.id, { name: 'SURA' }),
      ).resolves.toMatchObject({ name: 'SURA' });
    });

    it('409 al renombrar a un nombre de otra lista viva', async () => {
      repo.seed({ name: 'Sura' });
      const other = repo.seed({ name: 'Allianz' });
      await expect(update.execute(other.id, { name: 'sura' })).rejects.toThrow(
        new ConflictException(PRICE_LIST_DUPLICATE_MESSAGE),
      );
      expect(other.name).toBe('Allianz');
    });

    it('cambia la moneda de una lista sin precios', async () => {
      const row = repo.seed({ currency: 'COP' });
      await expect(
        update.execute(row.id, { currency: 'usd' }),
      ).resolves.toMatchObject({ currency: 'USD' });
    });

    it('409 si cambia la moneda con precios; la misma moneda no molesta', async () => {
      const row = repo.seed({ currency: 'COP' });
      repo.seedPrice(row.id, 'c1', 1000);
      await expect(update.execute(row.id, { currency: 'USD' })).rejects.toThrow(
        new ConflictException(PRICE_LIST_CURRENCY_LOCKED_MESSAGE),
      );
      expect(row.currency).toBe('COP');
      await expect(
        update.execute(row.id, { currency: 'cop', name: 'Nueva' }),
      ).resolves.toMatchObject({ currency: 'COP', name: 'Nueva' });
    });

    it('400 con moneda desconocida', async () => {
      const row = repo.seed();
      await expect(update.execute(row.id, { currency: 'ZZZ' })).rejects.toThrow(
        new BadRequestException(PRICE_LIST_CURRENCY_UNKNOWN_MESSAGE),
      );
    });

    it('asigna y quita la sede; una sede ajena da 400', async () => {
      const row = repo.seed();
      await expect(
        update.execute(row.id, { locationId: SEDE_SUR }),
      ).resolves.toMatchObject({ locationId: SEDE_SUR });
      await expect(
        update.execute(row.id, { locationId: null }),
      ).resolves.toMatchObject({ locationId: null });
      await expect(
        update.execute(row.id, {
          locationId: '33333333-3333-4333-8333-333333333333',
        }),
      ).rejects.toThrow(
        new BadRequestException(PRICE_LIST_LOCATION_NOT_FOUND_MESSAGE),
      );
    });

    it('409 al mover una lista activa a una sede que ya tiene otra activa', async () => {
      repo.seed({ name: 'Norte', locationId: SEDE_NORTE });
      const row = repo.seed({ name: 'Otra' });
      await expect(
        update.execute(row.id, { locationId: SEDE_NORTE }),
      ).rejects.toThrow(
        new ConflictException(PRICE_LIST_LOCATION_TAKEN_MESSAGE),
      );
      expect(row.locationId).toBeNull();
    });

    it('409 al reactivar una lista cuya sede ya tiene otra activa; desactivada sí puede moverse', async () => {
      repo.seed({ name: 'Norte', locationId: SEDE_NORTE });
      const off = repo.seed({
        name: 'Vieja Norte',
        locationId: SEDE_NORTE,
        active: false,
      });
      await expect(update.execute(off.id, { active: true })).rejects.toThrow(
        new ConflictException(PRICE_LIST_LOCATION_TAKEN_MESSAGE),
      );
      // Desactivada, puede quedarse en la sede ocupada.
      await expect(
        update.execute(off.id, { name: 'Vieja Norte 2' }),
      ).resolves.toMatchObject({ active: false, locationId: SEDE_NORTE });
    });

    it('editar la propia lista activa de la sede no choca consigo misma', async () => {
      const row = repo.seed({ name: 'Norte', locationId: SEDE_NORTE });
      await expect(
        update.execute(row.id, { locationId: SEDE_NORTE, active: true }),
      ).resolves.toMatchObject({ locationId: SEDE_NORTE });
    });
  });

  describe('retirar', () => {
    it('retira una lista sin convenios y la saca del listado', async () => {
      const row = repo.seed({ name: 'Sura' });
      await remove.execute(row.id, 'u1');
      expect(await list.execute({ includeInactive: true })).toEqual([]);
    });

    it('409 con un convenio vivo, y no se retira', async () => {
      const row = repo.seed();
      repo.liveAgreements.set(row.id, 1);
      await expect(remove.execute(row.id)).rejects.toThrow(
        new ConflictException(PRICE_LIST_IN_USE_MESSAGE),
      );
      expect(repo.deleted.has(row.id)).toBe(false);
    });

    it('404 si no existe o ya está retirada', async () => {
      await expect(remove.execute('nope')).rejects.toThrow(
        new NotFoundException(PRICE_LIST_NOT_FOUND_MESSAGE),
      );
      const row = repo.seed();
      await remove.execute(row.id);
      await expect(remove.execute(row.id)).rejects.toThrow(
        new NotFoundException(PRICE_LIST_NOT_FOUND_MESSAGE),
      );
    });
  });

  describe('directorio de precios de la lista', () => {
    beforeEach(() => {
      for (let i = 1; i <= 25; i++) {
        const n = String(i).padStart(2, '0');
        repo.catalog.push({
          catalogItemId: `c${n}`,
          code: `P-${n}`,
          labelEs: i === 7 ? 'Endodoncia' : `Procedimiento ${n}`,
          category: null,
          defaultPrice: null,
        });
      }
    });

    it('404 si la lista no existe', async () => {
      await expect(listItems.execute('nope')).rejects.toThrow(
        new NotFoundException(PRICE_LIST_NOT_FOUND_MESSAGE),
      );
    });

    it('pagina (20 por defecto), trae el total de la búsqueda y mezcla el precio de la lista o null', async () => {
      const row = repo.seed();
      repo.seedPrice(row.id, 'c01', 150000);

      const first = await listItems.execute(row.id);
      expect(first).toMatchObject({ total: 25, page: 1, pageSize: 20 });
      expect(first.items).toHaveLength(20);
      expect(first.items[0]).toMatchObject({ code: 'P-01', price: 150000 });
      expect(first.items[1]).toMatchObject({ code: 'P-02', price: null });

      const second = await listItems.execute(row.id, { page: 2 });
      expect(second.items).toHaveLength(5);
    });

    it('una búsqueda en blanco es «sin búsqueda»; acota pageSize a 100 y repara la página', async () => {
      const row = repo.seed();
      const blank = await listItems.execute(row.id, { query: '   ' });
      expect(blank.total).toBe(25);
      const huge = await listItems.execute(row.id, { pageSize: 5000, page: 0 });
      expect(huge).toMatchObject({ pageSize: 100, page: 1 });
      const found = await listItems.execute(row.id, { query: ' endo ' });
      expect(found.total).toBe(1);
    });
  });

  describe('reemplazar precios por lote', () => {
    it('upsert de filas con precio y borrado de las null; devuelve el recuento', async () => {
      const row = repo.seed();
      repo.seedPrice(row.id, 'c2', 500);
      const result = await replace.execute(row.id, [
        { catalogItemId: 'c1', price: 1000 },
        { catalogItemId: 'c2', price: null },
        { catalogItemId: 'c3', price: 0 },
      ]);
      expect(result).toEqual({ upserted: 2, removed: 1 });
      expect(Object.fromEntries(repo.prices.get(row.id) ?? [])).toEqual({
        c1: 1000,
        c3: 0,
      });
    });

    it('un lote vacío es válido y no toca nada', async () => {
      const row = repo.seed();
      await expect(replace.execute(row.id, [])).resolves.toEqual({
        upserted: 0,
        removed: 0,
      });
    });

    it('400 y NADA escrito si una prestación no es de la clínica', async () => {
      const row = repo.seed();
      await expect(
        replace.execute(row.id, [
          { catalogItemId: 'c1', price: 1000 },
          { catalogItemId: 'ajena', price: 2000 },
        ]),
      ).rejects.toThrow(
        new BadRequestException(PRICE_LIST_CATALOG_ITEMS_MESSAGE),
      );
      expect(repo.replaceCalls).toBe(0);
      expect(repo.prices.get(row.id)).toBeUndefined();
    });

    it('400 si la misma prestación viene dos veces', async () => {
      const row = repo.seed();
      await expect(
        replace.execute(row.id, [
          { catalogItemId: 'c1', price: 1 },
          { catalogItemId: 'c1', price: 2 },
        ]),
      ).rejects.toThrow(
        new BadRequestException(PRICE_LIST_DUPLICATED_ITEMS_MESSAGE),
      );
      expect(repo.replaceCalls).toBe(0);
    });

    it('404 si la lista no existe, sin tocar nada', async () => {
      await expect(
        replace.execute('nope', [{ catalogItemId: 'c1', price: 1 }]),
      ).rejects.toThrow(new NotFoundException(PRICE_LIST_NOT_FOUND_MESSAGE));
      expect(repo.replaceCalls).toBe(0);
    });
  });
});
