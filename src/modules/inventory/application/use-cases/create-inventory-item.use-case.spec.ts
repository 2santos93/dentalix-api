import { BadRequestException } from '@nestjs/common';
import { CreateInventoryItemUseCase } from './create-inventory-item.use-case';
import { InMemoryInventoryRepository } from './__fixtures__/in-memory-inventory.repository';

describe('CreateInventoryItemUseCase', () => {
  function makeUseCase() {
    const repo = new InMemoryInventoryRepository();
    return { repo, uc: new CreateInventoryItemUseCase(repo) };
  }

  it('creates an item with the given fields and default minStock 0', async () => {
    const { uc } = makeUseCase();

    const item = await uc.execute({ name: 'Gasas', unit: 'caja' });

    expect(item.name).toBe('Gasas');
    expect(item.unit).toBe('caja');
    expect(item.minStock).toBe(0);
    expect(item.sku).toBeNull();
    expect(item.notes).toBeNull();
  });

  it('trims name/unit/sku and persists an explicit minStock', async () => {
    const { uc } = makeUseCase();

    const item = await uc.execute({
      name: '  Guantes  ',
      unit: ' caja ',
      sku: ' GT-100 ',
      minStock: 5,
      notes: 'stock crítico',
    });

    expect(item.name).toBe('Guantes');
    expect(item.unit).toBe('caja');
    expect(item.sku).toBe('GT-100');
    expect(item.minStock).toBe(5);
    expect(item.notes).toBe('stock crítico');
  });

  it('accepts createdById as a separate argument, never from input', async () => {
    const { uc, repo } = makeUseCase();

    const item = await uc.execute({ name: 'Anestesia', unit: 'ml' }, 'user-1');

    expect(item.createdById).toBe('user-1');
    const stored = await repo.findItemById(item.id);
    expect(stored?.createdById).toBe('user-1');
  });

  it('rejects a blank name with 400', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute({ name: '   ', unit: 'unidad' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a blank unit with 400', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute({ name: 'Gasas', unit: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a negative minStock with 400', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute({ name: 'Gasas', unit: 'caja', minStock: -1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-finite minStock with 400', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute({ name: 'Gasas', unit: 'caja', minStock: Infinity }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
