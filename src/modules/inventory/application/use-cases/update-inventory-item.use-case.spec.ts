import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UpdateInventoryItemUseCase } from './update-inventory-item.use-case';
import { InMemoryInventoryRepository } from './__fixtures__/in-memory-inventory.repository';

describe('UpdateInventoryItemUseCase', () => {
  function makeUseCase() {
    const repo = new InMemoryInventoryRepository();
    return { repo, uc: new UpdateInventoryItemUseCase(repo) };
  }

  it('throws NotFoundException when the item is absent (or another tenant)', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute('missing-id', { name: 'New name' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates only the provided fields, trimmed', async () => {
    const { repo, uc } = makeUseCase();
    const item = repo.seedItem({ name: 'Old', unit: 'unidad', minStock: 1 });

    const updated = await uc.execute(item.id, { name: '  New name  ' });

    expect(updated.name).toBe('New name');
    expect(updated.unit).toBe('unidad');
    expect(updated.minStock).toBe(1);
  });

  it('rejects a blank name with 400', async () => {
    const { repo, uc } = makeUseCase();
    const item = repo.seedItem();

    await expect(uc.execute(item.id, { name: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a blank unit with 400', async () => {
    const { repo, uc } = makeUseCase();
    const item = repo.seedItem();

    await expect(uc.execute(item.id, { unit: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a negative minStock with 400', async () => {
    const { repo, uc } = makeUseCase();
    const item = repo.seedItem();

    await expect(uc.execute(item.id, { minStock: -1 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('allows clearing sku/notes to null', async () => {
    const { repo, uc } = makeUseCase();
    const item = repo.seedItem({ sku: 'SKU-1', notes: 'old note' });

    const updated = await uc.execute(item.id, { sku: null, notes: null });

    expect(updated.sku).toBeNull();
    expect(updated.notes).toBeNull();
  });

  it('throws NotFoundException for a soft-deleted item', async () => {
    const { repo, uc } = makeUseCase();
    const item = repo.seedItem({
      deletedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    await expect(uc.execute(item.id, { name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
