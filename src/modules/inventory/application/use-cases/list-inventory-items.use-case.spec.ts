import { InventoryMovementType } from '@prisma/client';
import { ListInventoryItemsUseCase } from './list-inventory-items.use-case';
import { InMemoryInventoryRepository } from './__fixtures__/in-memory-inventory.repository';

describe('ListInventoryItemsUseCase', () => {
  it('returns stock 0 and lowStock (0 <= 0 minStock) for an item with no movements', async () => {
    const repo = new InMemoryInventoryRepository();
    repo.seedItem({ name: 'A', minStock: 0 });
    const uc = new ListInventoryItemsUseCase(repo);

    const [item] = await uc.execute();

    expect(item.stock).toBe(0);
    expect(item.lowStock).toBe(true);
  });

  it('computes stock across IN -> OUT -> ADJUSTMENT(-) -> ADJUSTMENT(+) for one item', async () => {
    const repo = new InMemoryInventoryRepository();
    const item = repo.seedItem({ name: 'Gasas', minStock: 5 });
    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.IN,
      quantity: 10,
    });
    const uc = new ListInventoryItemsUseCase(repo);
    expect((await uc.execute())[0].stock).toBe(10);

    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.OUT,
      quantity: 7,
    });
    expect((await uc.execute())[0].stock).toBe(3);

    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.ADJUSTMENT,
      quantity: -1,
    });
    expect((await uc.execute())[0].stock).toBe(2);

    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.ADJUSTMENT,
      quantity: 5,
    });
    expect((await uc.execute())[0].stock).toBe(7);
  });

  it('lowStock flips at the minStock boundary (stock <= minStock)', async () => {
    const repo = new InMemoryInventoryRepository();
    const item = repo.seedItem({ name: 'Gasas', minStock: 5 });
    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.IN,
      quantity: 3,
    });
    const uc = new ListInventoryItemsUseCase(repo);

    // stock 3, minStock 5 -> 3 <= 5 -> lowStock true
    expect((await uc.execute())[0].lowStock).toBe(true);

    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.IN,
      quantity: 4,
    });
    // stock 7, minStock 5 -> 7 <= 5 is false -> lowStock false
    expect((await uc.execute())[0].lowStock).toBe(false);
  });

  it('lowStock is true when stock equals minStock exactly (boundary is inclusive)', async () => {
    const repo = new InMemoryInventoryRepository();
    const item = repo.seedItem({ name: 'Gasas', minStock: 5 });
    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.IN,
      quantity: 5,
    });
    const uc = new ListInventoryItemsUseCase(repo);

    expect((await uc.execute())[0].stock).toBe(5);
    expect((await uc.execute())[0].lowStock).toBe(true);
  });

  it('computes stock independently per item — no cross-contamination', async () => {
    const repo = new InMemoryInventoryRepository();
    const itemA = repo.seedItem({ name: 'A', minStock: 0 });
    const itemB = repo.seedItem({ name: 'B', minStock: 0 });
    repo.seedMovement({
      itemId: itemA.id,
      type: InventoryMovementType.IN,
      quantity: 10,
    });
    repo.seedMovement({
      itemId: itemB.id,
      type: InventoryMovementType.IN,
      quantity: 3,
    });
    repo.seedMovement({
      itemId: itemB.id,
      type: InventoryMovementType.OUT,
      quantity: 1,
    });
    const uc = new ListInventoryItemsUseCase(repo);

    const items = await uc.execute();
    const a = items.find((i) => i.id === itemA.id);
    const b = items.find((i) => i.id === itemB.id);

    expect(a?.stock).toBe(10);
    expect(b?.stock).toBe(2);
  });

  it('excludes a soft-deleted item from the list', async () => {
    const repo = new InMemoryInventoryRepository();
    repo.seedItem({ name: 'Active' });
    repo.seedItem({
      name: 'Deleted',
      deletedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const uc = new ListInventoryItemsUseCase(repo);

    const items = await uc.execute();

    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Active');
  });

  it('returns an empty array when there are no items', async () => {
    const repo = new InMemoryInventoryRepository();
    const uc = new ListInventoryItemsUseCase(repo);

    await expect(uc.execute()).resolves.toEqual([]);
  });
});
