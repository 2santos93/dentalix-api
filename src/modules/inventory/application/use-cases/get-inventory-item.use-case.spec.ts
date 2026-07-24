import { NotFoundException } from '@nestjs/common';
import { InventoryMovementType } from '@prisma/client';
import { GetInventoryItemUseCase } from './get-inventory-item.use-case';
import { InMemoryInventoryRepository } from './__fixtures__/in-memory-inventory.repository';

describe('GetInventoryItemUseCase', () => {
  it('throws NotFoundException when the item is absent (or another tenant)', async () => {
    const repo = new InMemoryInventoryRepository();
    const uc = new GetInventoryItemUseCase(repo);

    await expect(uc.execute('missing-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns the item with computed stock, lowStock and its movements', async () => {
    const repo = new InMemoryInventoryRepository();
    const item = repo.seedItem({ name: 'Gasas', minStock: 5 });
    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.IN,
      quantity: 10,
    });
    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.OUT,
      quantity: 7,
    });
    const uc = new GetInventoryItemUseCase(repo);

    const result = await uc.execute(item.id);

    expect(result.stock).toBe(3);
    expect(result.lowStock).toBe(true);
    expect(result.movements).toHaveLength(2);
  });

  it('does not mix another item movements into stock/movements', async () => {
    const repo = new InMemoryInventoryRepository();
    const item = repo.seedItem({ name: 'A' });
    const other = repo.seedItem({ name: 'B' });
    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.IN,
      quantity: 10,
    });
    repo.seedMovement({
      itemId: other.id,
      type: InventoryMovementType.IN,
      quantity: 999,
    });
    const uc = new GetInventoryItemUseCase(repo);

    const result = await uc.execute(item.id);

    expect(result.stock).toBe(10);
    expect(result.movements).toHaveLength(1);
  });

  it('throws NotFoundException for a soft-deleted item', async () => {
    const repo = new InMemoryInventoryRepository();
    const item = repo.seedItem({
      name: 'Deleted',
      deletedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const uc = new GetInventoryItemUseCase(repo);

    await expect(uc.execute(item.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
