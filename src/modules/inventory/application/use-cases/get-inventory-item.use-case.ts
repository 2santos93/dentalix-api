import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { INVENTORY_REPOSITORY } from '../../domain/ports/inventory-repository.port';
import type { InventoryRepository } from '../../domain/ports/inventory-repository.port';
import { InventoryItemDetail } from '../../domain/entities/inventory-item.entity';

@Injectable()
export class GetInventoryItemUseCase {
  constructor(
    @Inject(INVENTORY_REPOSITORY)
    private readonly repo: InventoryRepository,
  ) {}

  async execute(id: string): Promise<InventoryItemDetail> {
    const item = await this.repo.findItemById(id);
    if (!item) {
      // Same rationale as GetTreatmentPlanUseCase: a missing row and a row
      // that belongs to another tenant are indistinguishable here (RLS
      // makes cross-tenant rows invisible), so both surface as NotFound.
      throw new NotFoundException('Inventory item not found');
    }

    const [movements, stock] = await Promise.all([
      this.repo.listMovements(id),
      this.repo.sumSignedQuantity(id),
    ]);

    return {
      ...item,
      stock,
      lowStock: stock <= item.minStock,
      movements,
    };
  }
}
