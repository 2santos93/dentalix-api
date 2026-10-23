import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CATEGORY_DUPLICATE_MESSAGE,
  CATEGORY_NAME_MESSAGE,
  CATEGORY_NOT_FOUND_MESSAGE,
} from '../../domain/expense-rules';
import { PREDEFINED_EXPENSE_CATEGORIES } from '../../domain/expense-categories';
import { InMemoryExpenseCategoryRepository } from '../__fixtures__/in-memory-expenses';
import {
  CreateExpenseCategoryUseCase,
  DeleteExpenseCategoryUseCase,
  ListExpenseCategoriesUseCase,
} from './expense-categories.use-cases';

describe('categorías de gastos (DX-274)', () => {
  let repo: InMemoryExpenseCategoryRepository;
  let list: ListExpenseCategoriesUseCase;
  let create: CreateExpenseCategoryUseCase;
  let remove: DeleteExpenseCategoryUseCase;

  beforeEach(() => {
    repo = new InMemoryExpenseCategoryRepository();
    list = new ListExpenseCategoriesUseCase(repo);
    create = new CreateExpenseCategoryUseCase(repo);
    remove = new DeleteExpenseCategoryUseCase(repo);
  });

  it('lista las predefinidas (id null) y luego las propias activas por nombre', async () => {
    repo.seed('Zapatos');
    repo.seed('Alfombras');
    const retired = repo.seed('Retirada');
    await repo.retire(retired.id);
    const out = await list.execute();
    expect(out.slice(0, PREDEFINED_EXPENSE_CATEGORIES.length)).toEqual(
      PREDEFINED_EXPENSE_CATEGORIES.map((name) => ({
        id: null,
        name,
        predefined: true,
      })),
    );
    const custom = out.slice(PREDEFINED_EXPENSE_CATEGORIES.length);
    expect(custom.map((c) => [c.name, c.predefined])).toEqual([
      ['Alfombras', false],
      ['Zapatos', false],
    ]);
    expect(custom.every((c) => typeof c.id === 'string')).toBe(true);
  });

  describe('crear', () => {
    it('normaliza el nombre y devuelve la propia', async () => {
      const out = await create.execute('  Seguros   médicos ', 'u1');
      expect(out).toMatchObject({ name: 'Seguros médicos', predefined: false });
      expect(typeof out.id).toBe('string');
    });

    it('rechaza nombres fuera de 2–60', async () => {
      await expect(create.execute('A', 'u1')).rejects.toThrow(
        CATEGORY_NAME_MESSAGE,
      );
      await expect(create.execute('x'.repeat(61), 'u1')).rejects.toThrow(
        CATEGORY_NAME_MESSAGE,
      );
    });

    it('409 si choca con una predefinida o una propia (sin mayúsculas ni tildes)', async () => {
      const dup = new ConflictException(CATEGORY_DUPLICATE_MESSAGE);
      await expect(create.execute('papeleria', 'u1')).rejects.toThrow(dup);
      repo.seed('Seguros');
      await expect(create.execute(' SEGUROS ', 'u1')).rejects.toThrow(dup);
    });

    it('409 si pierde la carrera contra otra alta idéntica', async () => {
      repo.loseNextCreate = true;
      await expect(create.execute('Seguros', 'u1')).rejects.toThrow(
        CATEGORY_DUPLICATE_MESSAGE,
      );
    });

    it('una retirada libera el nombre', async () => {
      const first = await create.execute('Seguros', 'u1');
      await remove.execute(first.id!);
      await expect(create.execute('Seguros', 'u1')).resolves.toMatchObject({
        name: 'Seguros',
      });
    });
  });

  describe('retirar', () => {
    it('es lógico: sale del selector', async () => {
      const c = repo.seed('Seguros');
      await remove.execute(c.id);
      expect((await list.execute()).some((x) => x.name === 'Seguros')).toBe(
        false,
      );
    });

    it('404 si no existe o ya está retirada', async () => {
      const c = repo.seed('Seguros');
      await remove.execute(c.id);
      await expect(remove.execute(c.id)).rejects.toThrow(
        new NotFoundException(CATEGORY_NOT_FOUND_MESSAGE),
      );
      await expect(remove.execute('nope')).rejects.toThrow(NotFoundException);
    });
  });
});
