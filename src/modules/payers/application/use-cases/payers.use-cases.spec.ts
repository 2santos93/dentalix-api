import { TEST_AUDIT } from '../../../audit/application/__fixtures__/test-audit-context';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InMemoryPayerRepository } from '../__fixtures__/in-memory-payers';
import {
  type CreatePayerInput,
  CreatePayerUseCase,
  DeletePayerUseCase,
  ListPayersUseCase,
  PAYER_DUPLICATE_INACTIVE_MESSAGE,
  PAYER_DUPLICATE_MESSAGE,
  PAYER_IN_USE_MESSAGE,
  PAYER_NOT_FOUND_MESSAGE,
  type UpdatePayerInput,
  UpdatePayerUseCase,
} from './payers.use-cases';
import { PAYER_NAME_MESSAGE } from '../../domain/payer-rules';
import { PAYER_TYPES } from '../../domain/payer-type';

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
      repo.seed({ name: 'Surco' });
      repo.seed({ name: 'Adeslas', type: 'INSURER' });
      repo.seed({ name: 'Colsanavida', active: false });
      const retired = repo.seed({ name: 'Retirada' });
      repo.deleted.add(retired.id);

      expect((await list.execute({})).map((p) => p.name)).toEqual([
        'Adeslas',
        'Surco',
      ]);
      expect(
        (await list.execute({ includeInactive: true })).map((p) => p.name),
      ).toEqual(['Adeslas', 'Colsanavida', 'Surco']);
    });
  });

  describe('crear', () => {
    it('normaliza el nombre', async () => {
      const payer = await create.execute(
        { name: '  Empresa   Uno ', type: 'EMPLOYER' },
        TEST_AUDIT,
      );
      expect(payer).toMatchObject({
        name: 'Empresa Uno',
        type: 'EMPLOYER',
        active: true,
      });
    });

    it.each(PAYER_TYPES)(
      'any type is created with no country (%s)',
      async (type) => {
        const payer = await create.execute(
          { name: 'Aseguradora Norte', type },
          TEST_AUDIT,
        );
        expect(payer.type).toBe(type);
        expect(repo.rows).toHaveLength(1);
        expect(repo.rows[0]).not.toHaveProperty('country');
        expect(payer).not.toHaveProperty('country');
      },
    );

    it('the use cases take no country', () => {
      const createInput: CreatePayerInput = {
        name: 'Plan Sur',
        type: 'PREPAID_PLAN',
        // @ts-expect-error: el pagador no tiene país (DX-326).
        country: null,
      };
      const updateInput: UpdatePayerInput = {
        // @ts-expect-error: el pagador no tiene país (DX-326).
        country: null,
      };
      expect(createInput.name).toBe('Plan Sur');
      expect(updateInput).toBeDefined();
    });

    it('400 con nombre corto', async () => {
      await expect(
        create.execute({ name: ' A ', type: 'OTHER' }, TEST_AUDIT),
      ).rejects.toThrow(new BadRequestException(PAYER_NAME_MESSAGE));
    });

    it('409 con un nombre que solo cambia en mayúsculas, tildes o espacios', async () => {
      repo.seed({ name: 'Seguros Bolívar', type: 'OTHER' });
      await expect(
        create.execute(
          { name: ' SEGUROS  bolivar', type: 'OTHER' },
          TEST_AUDIT,
        ),
      ).rejects.toThrow(new ConflictException(PAYER_DUPLICATE_MESSAGE));
      expect(repo.rows).toHaveLength(1);
    });

    it('409 propio si el que coincide está desactivado, al crear y al renombrar', async () => {
      repo.seed({ name: 'Surco', active: false });
      await expect(
        create.execute({ name: 'SURCO', type: 'OTHER' }, TEST_AUDIT),
      ).rejects.toThrow(
        new ConflictException(PAYER_DUPLICATE_INACTIVE_MESSAGE),
      );
      const other = repo.seed({ name: 'Allianz' });
      await expect(
        update.execute(other.id, { name: 'surco' }, TEST_AUDIT),
      ).rejects.toThrow(
        new ConflictException(PAYER_DUPLICATE_INACTIVE_MESSAGE),
      );
    });

    it('permite reutilizar el nombre de un pagador retirado', async () => {
      const old = repo.seed({ name: 'Surco' });
      repo.deleted.add(old.id);
      await expect(
        create.execute({ name: 'surco', type: 'PUBLIC_SYSTEM' }, TEST_AUDIT),
      ).resolves.toMatchObject({ name: 'surco' });
    });
  });

  describe('editar', () => {
    it('404 si no existe o está retirado', async () => {
      await expect(
        update.execute('nope', { active: false }, TEST_AUDIT),
      ).rejects.toThrow(new NotFoundException(PAYER_NOT_FOUND_MESSAGE));
      const gone = repo.seed();
      repo.deleted.add(gone.id);
      await expect(
        update.execute(gone.id, { active: false }, TEST_AUDIT),
      ).rejects.toThrow(NotFoundException);
    });

    it('desactiva y renombra', async () => {
      const p = repo.seed({ name: 'Surco' });
      const out = await update.execute(
        p.id,
        {
          name: ' Surco  Salud ',
          active: false,
        },
        TEST_AUDIT,
      );
      expect(out).toMatchObject({ name: 'Surco Salud', active: false });
    });

    it('no choca consigo mismo al cambiar solo mayúsculas', async () => {
      const p = repo.seed({ name: 'surco' });
      await expect(
        update.execute(p.id, { name: 'SURCO' }, TEST_AUDIT),
      ).resolves.toMatchObject({
        name: 'SURCO',
      });
    });

    it('409 al renombrar hacia el nombre de otro', async () => {
      repo.seed({ name: 'Surco' });
      const other = repo.seed({ name: 'Allianz' });
      await expect(
        update.execute(other.id, { name: 'SURCO' }, TEST_AUDIT),
      ).rejects.toThrow(new ConflictException(PAYER_DUPLICATE_MESSAGE));
      expect(other.name).toBe('Allianz');
    });

    it('update changes the type with no other rule', async () => {
      const p = repo.seed({ type: 'OTHER' });
      await expect(
        update.execute(p.id, { type: 'INSURER' }, TEST_AUDIT),
      ).resolves.toMatchObject({ type: 'INSURER' });
      await expect(
        update.execute(p.id, { type: 'OTHER' }, TEST_AUDIT),
      ).resolves.toMatchObject({ type: 'OTHER' });
      expect(repo.rows[0].type).toBe('OTHER');
    });
  });

  describe('retirar', () => {
    it('404 si no existe', async () => {
      await expect(remove.execute('nope', TEST_AUDIT)).rejects.toThrow(
        new NotFoundException(PAYER_NOT_FOUND_MESSAGE),
      );
    });

    it('409 con coberturas vivas y no lo retira', async () => {
      const p = repo.seed();
      repo.liveCoverages.set(p.id, 2);
      await expect(remove.execute(p.id, TEST_AUDIT)).rejects.toThrow(
        new ConflictException(PAYER_IN_USE_MESSAGE),
      );
      expect(repo.deleted.has(p.id)).toBe(false);
    });

    it('sin coberturas lo retira', async () => {
      const p = repo.seed();
      await remove.execute(p.id, TEST_AUDIT);
      expect(repo.deleted.has(p.id)).toBe(true);
    });
  });
});
