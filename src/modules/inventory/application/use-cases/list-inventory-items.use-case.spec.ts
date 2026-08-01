import { InventoryMovementType } from '@prisma/client';
import { ListInventoryItemsUseCase } from './list-inventory-items.use-case';
import { InMemoryInventoryRepository } from './__fixtures__/in-memory-inventory.repository';

describe('ListInventoryItemsUseCase', () => {
  it('returns stock 0 and lowStock (0 <= 0 minStock) for an item with no movements', async () => {
    const repo = new InMemoryInventoryRepository();
    repo.seedItem({ name: 'A', minStock: 0 });
    const uc = new ListInventoryItemsUseCase(repo);

    const { items } = await uc.execute();

    expect(items[0].stock).toBe(0);
    expect(items[0].lowStock).toBe(true);
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
    expect((await uc.execute()).items[0].stock).toBe(10);

    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.OUT,
      quantity: 7,
    });
    expect((await uc.execute()).items[0].stock).toBe(3);

    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.ADJUSTMENT,
      quantity: -1,
    });
    expect((await uc.execute()).items[0].stock).toBe(2);

    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.ADJUSTMENT,
      quantity: 5,
    });
    expect((await uc.execute()).items[0].stock).toBe(7);
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
    expect((await uc.execute()).items[0].lowStock).toBe(true);

    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.IN,
      quantity: 4,
    });
    // stock 7, minStock 5 -> 7 <= 5 is false -> lowStock false
    expect((await uc.execute()).items[0].lowStock).toBe(false);
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

    const { items } = await uc.execute();
    expect(items[0].stock).toBe(5);
    expect(items[0].lowStock).toBe(true);
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

    const { items } = await uc.execute();
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

    const { items } = await uc.execute();

    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Active');
  });

  it('returns an empty array when there are no items', async () => {
    const repo = new InMemoryInventoryRepository();
    const uc = new ListInventoryItemsUseCase(repo);

    await expect(uc.execute()).resolves.toEqual(
      expect.objectContaining({ items: [], total: 0 }),
    );
  });

  describe('filtros y paginación', () => {
    it('1. sin filtros: devuelve todos, total = nº de ítems, page 1, pageSize 20 por defecto', async () => {
      const repo = new InMemoryInventoryRepository();
      repo.seedItem({ name: 'A' });
      repo.seedItem({ name: 'B' });
      repo.seedItem({ name: 'C' });
      const uc = new ListInventoryItemsUseCase(repo);

      const result = await uc.execute();

      expect(result.items).toHaveLength(3);
      expect(result.total).toBe(3);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
    });

    it('2. `query` se pasa al repositorio — el filtrado de texto es responsabilidad del repo', async () => {
      const repo = new InMemoryInventoryRepository();
      repo.seedItem({ name: 'Gasas estériles' });
      repo.seedItem({ name: 'Guantes de látex' });
      const uc = new ListInventoryItemsUseCase(repo);

      const result = await uc.execute({ query: 'gasas' });

      // El argumento capturado prueba que el filtrado lo hace el repo, no
      // un `.filter()` sobre `items` dentro del caso de uso.
      expect(repo.lastListItemsParams).toEqual({ query: 'gasas' });
      // El fake SÍ filtra (misma convención que el repo real), así que esto
      // también confirma que el resultado del repo llega intacto.
      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('Gasas estériles');
    });

    it('3. `lowStockOnly: true` deja solo los ítems con stock <= minStock', async () => {
      const repo = new InMemoryInventoryRepository();
      const a = repo.seedItem({ name: 'A', minStock: 5 });
      const b = repo.seedItem({ name: 'B', minStock: 10 });
      repo.seedMovement({
        itemId: a.id,
        type: InventoryMovementType.IN,
        quantity: 2,
      });
      repo.seedMovement({
        itemId: b.id,
        type: InventoryMovementType.IN,
        quantity: 40,
      });
      const uc = new ListInventoryItemsUseCase(repo);

      const result = await uc.execute({ lowStockOnly: true });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('A');
    });

    it('4. `total` refleja los filtros (lowStockOnly): 1 de 3 ítems bajo mínimo -> total === 1', async () => {
      const repo = new InMemoryInventoryRepository();
      const a = repo.seedItem({ name: 'A', minStock: 5 });
      const b = repo.seedItem({ name: 'B', minStock: 0 });
      const c = repo.seedItem({ name: 'C', minStock: 0 });
      // A: stock 1 <= minStock 5 -> low. B/C: stock 4 > minStock 0 -> not low.
      repo.seedMovement({
        itemId: a.id,
        type: InventoryMovementType.IN,
        quantity: 1,
      });
      repo.seedMovement({
        itemId: b.id,
        type: InventoryMovementType.IN,
        quantity: 4,
      });
      repo.seedMovement({
        itemId: c.id,
        type: InventoryMovementType.IN,
        quantity: 4,
      });
      const uc = new ListInventoryItemsUseCase(repo);

      const result = await uc.execute({ lowStockOnly: true });

      expect(result.total).toBe(1);
      expect(result.total).not.toBe(3);
    });

    it('5. paginación: 5 ítems, pageSize 2 -> page 1 trae 2, page 3 trae 1, page 4 trae [] con total 5', async () => {
      const repo = new InMemoryInventoryRepository();
      for (const name of ['A', 'B', 'C', 'D', 'E']) {
        repo.seedItem({ name });
      }
      const uc = new ListInventoryItemsUseCase(repo);

      const page1 = await uc.execute({ page: 1, pageSize: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page3 = await uc.execute({ page: 3, pageSize: 2 });
      expect(page3.items).toHaveLength(1);
      expect(page3.total).toBe(5);

      const page4 = await uc.execute({ page: 4, pageSize: 2 });
      expect(page4.items).toEqual([]);
      expect(page4.total).toBe(5);
    });

    it('6. valores inválidos se normalizan como en Pacientes: page <= 0 -> 1, pageSize <= 0 -> default', async () => {
      const repo = new InMemoryInventoryRepository();
      repo.seedItem({ name: 'A' });
      const uc = new ListInventoryItemsUseCase(repo);

      const zeroPage = await uc.execute({ page: 0 });
      expect(zeroPage.page).toBe(1);

      const negativePage = await uc.execute({ page: -3 });
      expect(negativePage.page).toBe(1);

      const zeroPageSize = await uc.execute({ pageSize: 0 });
      expect(zeroPageSize.pageSize).toBe(20);
    });

    it('7. `lowStock` sigue calculándose por ítem y viaja en la respuesta', async () => {
      const repo = new InMemoryInventoryRepository();
      const item = repo.seedItem({ name: 'A', minStock: 5 });
      repo.seedMovement({
        itemId: item.id,
        type: InventoryMovementType.IN,
        quantity: 2,
      });
      const uc = new ListInventoryItemsUseCase(repo);

      const result = await uc.execute();

      expect(result.items[0].stock).toBe(2);
      expect(result.items[0].lowStock).toBe(true);
    });
  });
});
