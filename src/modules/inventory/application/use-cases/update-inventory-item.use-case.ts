import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { INVENTORY_REPOSITORY } from '../../domain/ports/inventory-repository.port';
import type { InventoryRepository } from '../../domain/ports/inventory-repository.port';
import { InventoryItem } from '../../domain/entities/inventory-item.entity';

export interface UpdateInventoryItemInput {
  name?: string;
  sku?: string | null;
  unit?: string;
  minStock?: number;
  notes?: string | null;
}

@Injectable()
export class UpdateInventoryItemUseCase {
  constructor(
    @Inject(INVENTORY_REPOSITORY)
    private readonly repo: InventoryRepository,
  ) {}

  async execute(
    id: string,
    input: UpdateInventoryItemInput,
  ): Promise<InventoryItem> {
    const existing = await this.repo.findItemById(id);
    if (!existing) {
      // Same rationale as UpdateTreatmentPlanUseCase: a missing row and a
      // row that belongs to another tenant are indistinguishable here (RLS
      // makes cross-tenant rows invisible), so both surface as NotFound.
      throw new NotFoundException('Inventory item not found');
    }

    let name: string | undefined;
    if (input.name !== undefined) {
      name = input.name.trim();
      if (!name) {
        throw new BadRequestException('name must not be blank');
      }
    }

    let unit: string | undefined;
    if (input.unit !== undefined) {
      unit = input.unit.trim();
      if (!unit) {
        throw new BadRequestException('unit must not be blank');
      }
    }

    if (
      input.minStock !== undefined &&
      (!Number.isFinite(input.minStock) || input.minStock < 0)
    ) {
      throw new BadRequestException('minStock must be a number >= 0');
    }

    return this.repo.updateItem(id, {
      name,
      sku: input.sku,
      unit,
      minStock: input.minStock,
      notes: input.notes,
    });
  }
}
