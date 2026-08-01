import { NotFoundException } from '@nestjs/common';
import { DeleteInventoryItemUseCase } from './delete-inventory-item.use-case';
import { ListInventoryItemsUseCase } from './list-inventory-items.use-case';
import { InMemoryInventoryRepository } from './__fixtures__/in-memory-inventory.repository';

describe('DeleteInventoryItemUseCase', () => {
  it('throws NotFoundException when the item is absent (or another tenant)', async () => {
    const repo = new InMemoryInventoryRepository();
    const uc = new DeleteInventoryItemUseCase(repo);

    await expect(uc.execute('missing-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('soft-deletes the item — it disappears from ListInventoryItems', async () => {
    const repo = new InMemoryInventoryRepository();
    const item = repo.seedItem({ name: 'To remove' });
    const uc = new DeleteInventoryItemUseCase(repo);
    const listUc = new ListInventoryItemsUseCase(repo);

    expect(await repo.findItemById(item.id)).not.toBeNull();
    await uc.execute(item.id);

    expect(await repo.findItemById(item.id)).toBeNull();
    expect((await listUc.execute()).items).toEqual([]);
  });

  it('throws NotFoundException on a second delete (already soft-deleted)', async () => {
    const repo = new InMemoryInventoryRepository();
    const item = repo.seedItem();
    const uc = new DeleteInventoryItemUseCase(repo);

    await uc.execute(item.id);

    await expect(uc.execute(item.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
