import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { INVENTORY_REPOSITORY } from '../../domain/ports/inventory-repository.port';
import type { InventoryRepository } from '../../domain/ports/inventory-repository.port';

@Injectable()
export class DeleteInventoryItemUseCase {
  constructor(
    @Inject(INVENTORY_REPOSITORY)
    private readonly repo: InventoryRepository,
  ) {}

  async execute(id: string): Promise<void> {
    const existing = await this.repo.findItemById(id);
    if (!existing) {
      throw new NotFoundException('Inventory item not found');
    }

    // Soft-delete only — never a hard delete on a domain table. Movements
    // are untouched (they are immutable history, independent of the item's
    // lifecycle).
    await this.repo.softDeleteItem(id);
  }
}
