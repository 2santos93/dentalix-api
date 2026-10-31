import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InMemoryAgreementRepository } from '../__fixtures__/in-memory-agreements';
import { InMemoryPayerRepository } from '../../../payers/application/__fixtures__/in-memory-payers';
import { InMemoryPriceListRepository } from '../../../price-lists/application/__fixtures__/in-memory-price-lists';
import {
  CreateAgreementUseCase,
  DeleteAgreementUseCase,
  ListAgreementsUseCase,
  UpdateAgreementUseCase,
} from './agreements.use-cases';
import {
  AGREEMENT_DATE_RANGE_MESSAGE,
  AGREEMENT_DUPLICATE_MESSAGE,
  AGREEMENT_IN_USE_MESSAGE,
  AGREEMENT_LOCATION_NOT_FOUND_MESSAGE,
  AGREEMENT_NAME_MESSAGE,
  AGREEMENT_NOT_FOUND_MESSAGE,
  AGREEMENT_PAYER_INACTIVE_MESSAGE,
  AGREEMENT_PAYER_NOT_FOUND_MESSAGE,
  AGREEMENT_PERCENT_FORBIDDEN_MESSAGE,
  AGREEMENT_PERCENT_RANGE_MESSAGE,
  AGREEMENT_PERCENT_REQUIRED_MESSAGE,
  AGREEMENT_PRICE_LIST_FORBIDDEN_MESSAGE,
  AGREEMENT_PRICE_LIST_INACTIVE_MESSAGE,
  AGREEMENT_PRICE_LIST_NOT_FOUND_MESSAGE,
  AGREEMENT_PRICE_LIST_REQUIRED_MESSAGE,
} from '../../domain/agreement-rules';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';

const SEDE = '11111111-1111-4111-8111-111111111111';

describe('casos de uso de convenios (DX-105)', () => {
  let repo: InMemoryAgreementRepository;
  let payers: InMemoryPayerRepository;
  let priceLists: InMemoryPriceListRepository;
  let knownLocations: Set<string>;
  let categories: (string | null)[];
  let catalogCalls: unknown[];
  let locations: LocationRepository;
  let catalog: DentalCatalogRepository;
  let list: ListAgreementsUseCase;
  let create: CreateAgreementUseCase;
  let update: UpdateAgreementUseCase;
  let remove: DeleteAgreementUseCase;
  let payerId: string;
  let listId: string;

  beforeEach(() => {
    repo = new InMemoryAgreementRepository();
    payers = new InMemoryPayerRepository();
    priceLists = new InMemoryPriceListRepository();
    knownLocations = new Set([SEDE]);
    categories = ['Operatoria', 'Cirugía oral', null];
    catalogCalls = [];
    locations = {
      findById: (id: string) =>
        Promise.resolve(knownLocations.has(id) ? ({ id } as never) : null),
    } as unknown as LocationRepository;
    catalog = {
      list: (params: unknown) => {
        catalogCalls.push(params);
        return Promise.resolve(
          categories.map((category) => ({ category }) as never),
        );
      },
    } as unknown as DentalCatalogRepository;
    list = new ListAgreementsUseCase(repo);
    create = new CreateAgreementUseCase(
      repo,
      payers,
      priceLists,
      locations,
      catalog,
    );
    update = new UpdateAgreementUseCase(
      repo,
      payers,
      priceLists,
      locations,
      catalog,
    );
    remove = new DeleteAgreementUseCase(repo);

    payerId = payers.seed({ name: 'Sanavida' }).id;
    listId = priceLists.seed({ name: 'Lista Sanavida', currency: 'COP' }).id;
    repo.payers.set(payerId, 'Sanavida');
    repo.priceLists.set(listId, { name: 'Lista Sanavida', currency: 'COP' });
  });

  describe('listar', () => {
    it('por defecto solo los activos, por nombre; includeInactive suma los desactivados y nunca los retirados', async () => {
      repo.seed({ name: 'Surco' });
      repo.seed({ name: 'Allianz' });
      repo.seed({ name: 'Colsanitas', active: false });
      const retired = repo.seed({ name: 'Retirado' });
      repo.deleted.add(retired.id);

      expect((await list.execute({})).map((a) => a.name)).toEqual([
        'Allianz',
        'Surco',
      ]);
      expect(
        (await list.execute({ includeInactive: true })).map((a) => a.name),
      ).toEqual(['Allianz', 'Colsanitas', 'Surco']);
    });
  });

  describe('crear', () => {
    it('descuento porcentual: normaliza el nombre y nace activo', async () => {
      const created = await create.execute(
        {
          name: '  Convenio   Sanavida ',
          payerId,
          kind: 'PERCENT_DISCOUNT',
          percent: 12.5,
          validFrom: '2026-01-01',
          validTo: '2026-12-31',
        },
        'u1',
      );
      expect(created).toMatchObject({
        name: 'Convenio Sanavida',
        payer: { id: payerId, name: 'Sanavida' },
        kind: 'PERCENT_DISCOUNT',
        percent: 12.5,
        percentByCategory: null,
        priceList: null,
        locationId: null,
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
        active: true,
      });
    });

    it('lista de precios: guarda la lista y ningún porcentaje', async () => {
      const created = await create.execute({
        name: 'Por lista',
        payerId,
        kind: 'PRICE_LIST',
        priceListId: listId,
        locationId: SEDE,
      });
      expect(created).toMatchObject({
        kind: 'PRICE_LIST',
        percent: null,
        percentByCategory: null,
        priceList: { id: listId, name: 'Lista Sanavida', currency: 'COP' },
        locationId: SEDE,
      });
    });

    it('guarda las categorías con la ortografía del catálogo', async () => {
      const created = await create.execute({
        name: 'Con categorías',
        payerId,
        kind: 'PERCENT_DISCOUNT',
        percent: 5,
        percentByCategory: { OPERATORIA: 20, 'cirugia oral': 0 },
      });
      expect(created.percentByCategory).toEqual({
        Operatoria: 20,
        'Cirugía oral': 0,
      });
      expect(catalogCalls).toEqual([{ activeOnly: true }]);
    });

    it('un mapa de categorías vacío se guarda como null y no consulta el catálogo', async () => {
      const created = await create.execute({
        name: 'Sin categorías',
        payerId,
        kind: 'PERCENT_DISCOUNT',
        percent: 5,
        percentByCategory: {},
      });
      expect(created.percentByCategory).toBeNull();
      expect(catalogCalls).toHaveLength(0);
    });

    it('400 con una categoría que no existe y no escribe nada', async () => {
      await expect(
        create.execute({
          name: 'Mala categoría',
          payerId,
          kind: 'PERCENT_DISCOUNT',
          percent: 5,
          percentByCategory: { Estética: 10 },
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'La categoría «Estética» no existe en el catálogo.',
        ),
      );
      expect(repo.rows).toHaveLength(0);
    });

    it('400 con nombre corto', async () => {
      await expect(
        create.execute({
          name: ' A ',
          payerId,
          kind: 'PERCENT_DISCOUNT',
          percent: 5,
        }),
      ).rejects.toThrow(new BadRequestException(AGREEMENT_NAME_MESSAGE));
    });

    it.each([
      [
        'sin porcentaje',
        { kind: 'PERCENT_DISCOUNT' as const },
        AGREEMENT_PERCENT_REQUIRED_MESSAGE,
      ],
      [
        'porcentaje mayor que 100',
        { kind: 'PERCENT_DISCOUNT' as const, percent: 100.01 },
        AGREEMENT_PERCENT_RANGE_MESSAGE,
      ],
      [
        'porcentaje negativo',
        { kind: 'PERCENT_DISCOUNT' as const, percent: -1 },
        AGREEMENT_PERCENT_RANGE_MESSAGE,
      ],
      [
        'descuento con lista',
        {
          kind: 'PERCENT_DISCOUNT' as const,
          percent: 5,
          priceListId: 'lista',
        },
        AGREEMENT_PRICE_LIST_FORBIDDEN_MESSAGE,
      ],
      [
        'lista de precios sin lista',
        { kind: 'PRICE_LIST' as const },
        AGREEMENT_PRICE_LIST_REQUIRED_MESSAGE,
      ],
      [
        'lista de precios con porcentaje',
        { kind: 'PRICE_LIST' as const, percent: 5, priceListId: 'lista' },
        AGREEMENT_PERCENT_FORBIDDEN_MESSAGE,
      ],
      [
        'vigencia invertida',
        {
          kind: 'PERCENT_DISCOUNT' as const,
          percent: 5,
          validFrom: '2026-02-01',
          validTo: '2026-01-01',
        },
        AGREEMENT_DATE_RANGE_MESSAGE,
      ],
    ])('400 %s', async (_label, input, message) => {
      await expect(
        create.execute({ name: 'Convenio', payerId, ...input }),
      ).rejects.toThrow(new BadRequestException(message));
      expect(repo.rows).toHaveLength(0);
    });

    it('400 con un pagador que no existe y con uno desactivado', async () => {
      await expect(
        create.execute({
          name: 'Convenio',
          payerId: 'otro',
          kind: 'PERCENT_DISCOUNT',
          percent: 5,
        }),
      ).rejects.toThrow(
        new BadRequestException(AGREEMENT_PAYER_NOT_FOUND_MESSAGE),
      );
      const off = payers.seed({ name: 'Apagado', active: false });
      await expect(
        create.execute({
          name: 'Convenio',
          payerId: off.id,
          kind: 'PERCENT_DISCOUNT',
          percent: 5,
        }),
      ).rejects.toThrow(
        new BadRequestException(AGREEMENT_PAYER_INACTIVE_MESSAGE),
      );
    });

    it('400 con una lista que no existe y con una desactivada', async () => {
      await expect(
        create.execute({
          name: 'Convenio',
          payerId,
          kind: 'PRICE_LIST',
          priceListId: 'otra',
        }),
      ).rejects.toThrow(
        new BadRequestException(AGREEMENT_PRICE_LIST_NOT_FOUND_MESSAGE),
      );
      const off = priceLists.seed({ name: 'Apagada', active: false });
      await expect(
        create.execute({
          name: 'Convenio',
          payerId,
          kind: 'PRICE_LIST',
          priceListId: off.id,
        }),
      ).rejects.toThrow(
        new BadRequestException(AGREEMENT_PRICE_LIST_INACTIVE_MESSAGE),
      );
    });

    it('400 «Sede no encontrada.» si la sede no es de la clínica', async () => {
      await expect(
        create.execute({
          name: 'Convenio',
          payerId,
          kind: 'PERCENT_DISCOUNT',
          percent: 5,
          locationId: '22222222-2222-4222-8222-222222222222',
        }),
      ).rejects.toThrow(
        new BadRequestException(AGREEMENT_LOCATION_NOT_FOUND_MESSAGE),
      );
    });

    it('409 si el nombre solo cambia en mayúsculas o tildes', async () => {
      repo.seed({ name: 'Convenio Bolívar' });
      await expect(
        create.execute({
          name: ' convenio  BOLIVAR',
          payerId,
          kind: 'PERCENT_DISCOUNT',
          percent: 5,
        }),
      ).rejects.toThrow(new ConflictException(AGREEMENT_DUPLICATE_MESSAGE));
    });

    it('un nombre retirado se puede reutilizar', async () => {
      const retired = repo.seed({ name: 'Reutilizable' });
      repo.deleted.add(retired.id);
      await expect(
        create.execute({
          name: 'Reutilizable',
          payerId,
          kind: 'PERCENT_DISCOUNT',
          percent: 5,
        }),
      ).resolves.toMatchObject({ name: 'Reutilizable' });
    });
  });

  describe('editar', () => {
    it('404 si no existe o está retirado', async () => {
      await expect(update.execute('nada', { name: 'Nuevo' })).rejects.toThrow(
        new NotFoundException(AGREEMENT_NOT_FOUND_MESSAGE),
      );
      const retired = repo.seed();
      repo.deleted.add(retired.id);
      await expect(
        update.execute(retired.id, { name: 'Nuevo' }),
      ).rejects.toThrow(new NotFoundException(AGREEMENT_NOT_FOUND_MESSAGE));
    });

    it('renombra, desactiva y solo toca lo que llega', async () => {
      const a = repo.seed({ name: 'Viejo', percent: 10 });
      const updated = await update.execute(
        a.id,
        { name: '  Nuevo   nombre ', active: false },
        'u2',
      );
      expect(updated).toMatchObject({
        name: 'Nuevo nombre',
        active: false,
        percent: 10,
      });
      expect(repo.lastPatch).toEqual({
        name: 'Nuevo nombre',
        active: false,
        updatedById: 'u2',
      });
    });

    it('409 al renombrar hacia el nombre de otro, pero no hacia el propio', async () => {
      repo.seed({ name: 'Otro' });
      const a = repo.seed({ name: 'Uno' });
      await expect(update.execute(a.id, { name: 'otro' })).rejects.toThrow(
        new ConflictException(AGREEMENT_DUPLICATE_MESSAGE),
      );
      await expect(
        update.execute(a.id, { name: 'UNO' }),
      ).resolves.toMatchObject({ name: 'UNO' });
    });

    it('PERCENT_DISCOUNT -> PRICE_LIST vacía el porcentaje y las categorías y pide la lista', async () => {
      const a = repo.seed({
        percent: 10,
        percentByCategory: { Operatoria: 5 },
      });
      await expect(
        update.execute(a.id, { kind: 'PRICE_LIST' }),
      ).rejects.toThrow(
        new BadRequestException(AGREEMENT_PRICE_LIST_REQUIRED_MESSAGE),
      );
      const updated = await update.execute(a.id, {
        kind: 'PRICE_LIST',
        priceListId: listId,
      });
      expect(updated).toMatchObject({
        kind: 'PRICE_LIST',
        percent: null,
        percentByCategory: null,
        priceList: { id: listId },
      });
    });

    it('PRICE_LIST -> PERCENT_DISCOUNT vacía la lista y pide el porcentaje', async () => {
      const a = repo.seed({
        kind: 'PRICE_LIST',
        percent: null,
        priceList: { id: listId, name: 'Lista Sanavida', currency: 'COP' },
      });
      await expect(
        update.execute(a.id, { kind: 'PERCENT_DISCOUNT' }),
      ).rejects.toThrow(
        new BadRequestException(AGREEMENT_PERCENT_REQUIRED_MESSAGE),
      );
      const updated = await update.execute(a.id, {
        kind: 'PERCENT_DISCOUNT',
        percent: 8,
      });
      expect(updated).toMatchObject({
        kind: 'PERCENT_DISCOUNT',
        percent: 8,
        priceList: null,
      });
      expect(repo.lastPatch?.priceListId).toBeNull();
    });

    it('sin cambiar de kind, mandar el campo del otro kind da 400', async () => {
      const percent = repo.seed({ percent: 10 });
      await expect(
        update.execute(percent.id, { priceListId: listId }),
      ).rejects.toThrow(
        new BadRequestException(AGREEMENT_PRICE_LIST_FORBIDDEN_MESSAGE),
      );
      const byList = repo.seed({
        name: 'Por lista',
        kind: 'PRICE_LIST',
        percent: null,
        priceList: { id: listId, name: 'Lista Sanavida', currency: 'COP' },
      });
      await expect(update.execute(byList.id, { percent: 5 })).rejects.toThrow(
        new BadRequestException(AGREEMENT_PERCENT_FORBIDDEN_MESSAGE),
      );
    });

    it('null en los campos del otro kind es lo mismo que no mandarlos', async () => {
      const a = repo.seed({ percent: 10 });
      await expect(
        update.execute(a.id, {
          kind: 'PERCENT_DISCOUNT',
          percent: 12,
          priceListId: null,
          percentByCategory: null,
        }),
      ).resolves.toMatchObject({ percent: 12 });
    });

    it('vaciar el porcentaje de un descuento da 400', async () => {
      const a = repo.seed({ percent: 10 });
      await expect(update.execute(a.id, { percent: null })).rejects.toThrow(
        new BadRequestException(AGREEMENT_PERCENT_REQUIRED_MESSAGE),
      );
    });

    it('las categorías se validan y se canonizan solo si llegan', async () => {
      const a = repo.seed({ percentByCategory: { Vieja: 5 } });
      // Una categoría ya guardada que dejó el catálogo no bloquea otro cambio.
      await update.execute(a.id, { percent: 11 });
      expect(catalogCalls).toHaveLength(0);

      await expect(
        update.execute(a.id, { percentByCategory: { Nada: 1 } }),
      ).rejects.toThrow(
        new BadRequestException(
          'La categoría «Nada» no existe en el catálogo.',
        ),
      );
      const updated = await update.execute(a.id, {
        percentByCategory: { operatoria: 30 },
      });
      expect(updated.percentByCategory).toEqual({ Operatoria: 30 });
      const cleared = await update.execute(a.id, { percentByCategory: null });
      expect(cleared.percentByCategory).toBeNull();
    });

    it('null borra la vigencia y el rango se valida contra lo guardado', async () => {
      const a = repo.seed({ validFrom: '2026-03-01', validTo: '2026-06-01' });
      await expect(
        update.execute(a.id, { validTo: '2026-02-01' }),
      ).rejects.toThrow(new BadRequestException(AGREEMENT_DATE_RANGE_MESSAGE));
      const cleared = await update.execute(a.id, {
        validFrom: null,
        validTo: null,
      });
      expect(cleared).toMatchObject({ validFrom: null, validTo: null });
    });

    it('cambiar de pagador exige uno vivo y activo; el mismo no se comprueba', async () => {
      const a = repo.seed({
        payer: { id: payerId, name: 'Sanavida', type: 'PUBLIC_SYSTEM' },
      });
      const off = payers.seed({ name: 'Apagado', active: false });
      await expect(update.execute(a.id, { payerId: off.id })).rejects.toThrow(
        new BadRequestException(AGREEMENT_PAYER_INACTIVE_MESSAGE),
      );
      payers.rows.find((p) => p.id === payerId)!.active = false;
      await expect(
        update.execute(a.id, { payerId, name: 'Renombrado' }),
      ).resolves.toMatchObject({ name: 'Renombrado' });
      expect(repo.lastPatch?.payerId).toBeUndefined();
    });

    it('cambiar de lista exige una viva y activa', async () => {
      const a = repo.seed({
        kind: 'PRICE_LIST',
        percent: null,
        priceList: { id: listId, name: 'Lista Sanavida', currency: 'COP' },
      });
      const off = priceLists.seed({ name: 'Apagada', active: false });
      await expect(
        update.execute(a.id, { priceListId: off.id }),
      ).rejects.toThrow(
        new BadRequestException(AGREEMENT_PRICE_LIST_INACTIVE_MESSAGE),
      );
      await expect(
        update.execute(a.id, { priceListId: 'fantasma' }),
      ).rejects.toThrow(
        new BadRequestException(AGREEMENT_PRICE_LIST_NOT_FOUND_MESSAGE),
      );
    });

    it('la sede se comprueba y null la vacía', async () => {
      const a = repo.seed({ locationId: SEDE });
      await expect(
        update.execute(a.id, {
          locationId: '33333333-3333-4333-8333-333333333333',
        }),
      ).rejects.toThrow(
        new BadRequestException(AGREEMENT_LOCATION_NOT_FOUND_MESSAGE),
      );
      await expect(
        update.execute(a.id, { locationId: null }),
      ).resolves.toMatchObject({ locationId: null });
    });

    it('404 si el convenio se retira entre la lectura y la escritura', async () => {
      const a = repo.seed();
      jest.spyOn(repo, 'update').mockResolvedValueOnce(null);
      await expect(update.execute(a.id, { active: false })).rejects.toThrow(
        new NotFoundException(AGREEMENT_NOT_FOUND_MESSAGE),
      );
    });
  });

  describe('retirar', () => {
    it('retira y deja de listarse', async () => {
      const a = repo.seed({ name: 'Para retirar' });
      await remove.execute(a.id, 'u1');
      expect(repo.deleted.has(a.id)).toBe(true);
      expect(await list.execute({ includeInactive: true })).toEqual([]);
    });

    it('409 con pacientes asignados y el convenio sigue', async () => {
      const a = repo.seed({ name: 'En uso' });
      repo.liveAssignments.set(a.id, 2);
      await expect(remove.execute(a.id)).rejects.toThrow(
        new ConflictException(AGREEMENT_IN_USE_MESSAGE),
      );
      expect(repo.deleted.has(a.id)).toBe(false);
    });

    it('404 si no existe o ya está retirado', async () => {
      await expect(remove.execute('nada')).rejects.toThrow(
        new NotFoundException(AGREEMENT_NOT_FOUND_MESSAGE),
      );
    });
  });

  describe('findLiveById', () => {
    it('da el convenio desactivado pero no el retirado', async () => {
      const off = repo.seed({ active: false });
      const gone = repo.seed();
      repo.deleted.add(gone.id);
      expect(await repo.findLiveById(off.id)).toMatchObject({
        id: off.id,
        active: false,
      });
      expect(await repo.findLiveById(gone.id)).toBeNull();
    });
  });
});
