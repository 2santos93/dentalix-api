import { Inject, Injectable } from '@nestjs/common';
import { INVENTORY_REPOSITORY } from '../../domain/ports/inventory-repository.port';
import type { InventoryRepository } from '../../domain/ports/inventory-repository.port';
import { InventoryItemWithStock } from '../../domain/entities/inventory-item.entity';

@Injectable()
export class ListInventoryItemsUseCase {
  constructor(
    @Inject(INVENTORY_REPOSITORY)
    private readonly repo: InventoryRepository,
  ) {}

  /**
   * Two queries total, REGARDLESS of how many items exist: `listItems()`
   * for the active rows, `sumSignedQuantityAll()` for every item's stock in
   * one aggregation — never one stock query per item (N+1). `lowStock` is
   * computed here, per item, from the same `stock` this call just resolved.
   */
  async execute(): Promise<InventoryItemWithStock[]> {
    const [items, stockByItemId] = await Promise.all([
      this.repo.listItems(),
      this.repo.sumSignedQuantityAll(),
    ]);

    return items.map((item) => {
      const stock = stockByItemId[item.id] ?? 0;
      return {
        ...item,
        stock,
        lowStock: stock <= item.minStock,
      };
    });
  }
}
