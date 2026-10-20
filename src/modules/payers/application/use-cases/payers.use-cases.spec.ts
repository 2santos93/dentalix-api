import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InMemoryPayerRepository } from '../__fixtures__/in-memory-payers';
import {
  CreatePayerUseCase,
  DeletePayerUseCase,
  ListPayersUseCase,
  PAYER_DUPLICATE_INACTIVE_MESSAGE,
  PAYER_DUPLICATE_MESSAGE,
  PAYER_IN_USE_MESSAGE,
  PAYER_NOT_FOUND_MESSAGE,
  UpdatePayerUseCase,
} from './payers.use-cases';
import {
  PAYER_NAME_MESSAGE,
  PAYER_TYPE_COUNTRY_MESSAGE,
} from '../../domain/payer-rules';

describe('casos de uso de pagadores (DX-153)', () => {
  let repo: InMemoryPayerRepository;
  let list: ListPayersUseCase;
  let create: CreatePayerUseCase;
  let update: UpdatePayerUseCase;
  let remove: DeletePayerUseCase;

  beforeEach(() => {
    repo = new InMemoryPayerRepository();
    list = new ListPayersUseCase(repo);
    create = new CreatePayerUseCase(repo);
    update = new UpdatePayerUseCase(repo);
    remove = new DeletePayerUseCase(repo);
  });

  describe('listar', () => {
    it('por defecto solo activos, por nombre; includeInactive suma los desactivados', async () => {
      repo.seed({ name: 'Sura' });
      repo.seed({ name: 'Adeslas', type: 'MUTUA_ES', country: 'ES' });
      repo.seed({ name: 'Colsanitas', active: false });
      const retired = repo.seed({ name: 'Retirada' });
      repo.deleted.add(retired.id);

      expect((await list.execute({})).map((p) => p.name)).toEqual([
        'Adeslas',
        'Sura',
      ]);
      expect(
        (await list.execute({ includeInactive: true })).map((p) => p.name),
      ).toEqual(['Adeslas', 'Colsanitas', 'Sura']);
    });
  });

  describe('crear', () => {
    it('normaliza el nombre y deja el país nulo si no viene', async () => {
      const payer = await create.execute(
        { name: '  Empresa   Uno ', type: 'EMPRESA' },
        'u1',
      );
      expect(payer).toMatchObject({
        name: 'Empresa Uno',
        type: 'EMPRESA',
        country: null,
        active: true,
      });
    });

    it('400 con nombre corto', async () => {
      await expect(
        create.execute({ name: ' A ', type: 'OTRO' }),
      ).rejects.toThrow(new BadRequestException(PAYER_NAME_MESSAGE));
    });

    it('400 si el tipo no corresponde con el país', async () => {
      await expect(
        create.execute({ name: 'Mutua X', type: 'MUTUA_ES', country: 'CO' }),
      ).rejects.toThrow(new BadRequestException(PAYER_TYPE_COUNTRY_MESSAGE));
      await expect(
        create.execute({ name: 'Mutua X', type: 'MUTUA_ES' }),
      ).rejects.toThrow(new BadRequestException(PAYER_TYPE_COUNTRY_MESSAGE));
      expect(repo.rows).toHaveLength(0);
    });

    it('409 con un nombre que solo cambia en mayúsculas, tildes o espacios', async () => {
      repo.seed({ name: 'Seguros Bolívar', type: 'OTRO', country: null });
      await expect(
        create.execute({ name: ' SEGUROS  bolivar', type: 'OTRO' }),
      ).rejects.toThrow(new ConflictException(PAYER_DUPLICATE_MESSAGE));
      expect(repo.rows).toHaveLength(1);
    });

    it('409 propio si el que coincide está desactivado, al crear y al renombrar', async () => {
      repo.seed({ name: 'Sura', active: false });
      await expect(
        create.execute({ name: 'SURA', type: 'OTRO' }),
      ).rejects.toThrow(
        new ConflictException(PAYER_DUPLICATE_INACTIVE_MESSAGE),
      );
      const other = repo.seed({ name: 'Allianz' });
      await expect(update.execute(other.id, { name: 'sura' })).rejects.toThrow(
        new ConflictException(PAYER_DUPLICATE_INACTIVE_MESSAGE),
      );
    });

    it('permite reutilizar el nombre de un pagador retirado', async () => {
      const old = repo.seed({ name: 'Sura' });
      repo.deleted.add(old.id);
      await expect(
        create.execute({ name: 'sura', type: 'EPS_CO', country: 'CO' }),
      ).resolves.toMatchObject({ name: 'sura' });
    });
  });

  describe('editar', () => {
    it('404 si no existe o está retirado', async () => {
      await expect(update.execute('nope', { active: false })).rejects.toThrow(
        new NotFoundException(PAYER_NOT_FOUND_MESSAGE),
      );
      const gone = repo.seed();
      repo.deleted.add(gone.id);
      await expect(update.execute(gone.id, { active: false })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('desactiva y renombra', async () => {
      const p = repo.seed({ name: 'Sura' });
      const out = await update.execute(p.id, {
        name: ' Sura  Salud ',
        active: false,
      });
      expect(out).toMatchObject({ name: 'Sura Salud', active: false });
    });

    it('no choca consigo mismo al cambiar solo mayúsculas', async () => {
      const p = repo.seed({ name: 'sura' });
      await expect(
        update.execute(p.id, { name: 'SURA' }),
      ).resolves.toMatchObject({
        name: 'SURA',
      });
    });

    it('409 al renombrar hacia el nombre de otro', async () => {
      repo.seed({ name: 'Sura' });
      const other = repo.seed({ name: 'Allianz' });
      await expect(update.execute(other.id, { name: 'SURA' })).rejects.toThrow(
        new ConflictException(PAYER_DUPLICATE_MESSAGE),
      );
      expect(other.name).toBe('Allianz');
    });

    it('valida tipo y país contra el valor resultante', async () => {
      const p = repo.seed({ type: 'EPS_CO', country: 'CO' });
      await expect(update.execute(p.id, { type: 'MUTUA_ES' })).rejects.toThrow(
        new BadRequestException(PAYER_TYPE_COUNTRY_MESSAGE),
      );
      await expect(update.execute(p.id, { country: 'ES' })).rejects.toThrow(
        new BadRequestException(PAYER_TYPE_COUNTRY_MESSAGE),
      );
      await expect(
        update.execute(p.id, { type: 'MUTUA_ES', country: 'ES' }),
      ).resolves.toMatchObject({ type: 'MUTUA_ES', country: 'ES' });
    });
  });

  describe('retirar', () => {
    it('404 si no existe', async () => {
      await expect(remove.execute('nope')).rejects.toThrow(
        new NotFoundException(PAYER_NOT_FOUND_MESSAGE),
      );
    });

    it('409 con coberturas vivas y no lo retira', async () => {
      const p = repo.seed();
      repo.liveCoverages.set(p.id, 2);
      await expect(remove.execute(p.id)).rejects.toThrow(
        new ConflictException(PAYER_IN_USE_MESSAGE),
      );
      expect(repo.deleted.has(p.id)).toBe(false);
    });

    it('sin coberturas lo retira', async () => {
      const p = repo.seed();
      await remove.execute(p.id, 'u1');
      expect(repo.deleted.has(p.id)).toBe(true);
    });
  });
});
