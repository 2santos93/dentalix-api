import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { INVENTORY_REPOSITORY } from '../../domain/ports/inventory-repository.port';
import type { InventoryRepository } from '../../domain/ports/inventory-repository.port';
import { InventoryItem } from '../../domain/entities/inventory-item.entity';

// NOTE: deliberately NO `tenantId`/`id` field — tenant comes from the
// guarded request context (the repository reads it, never this input),
// same convention as CreateTreatmentPlanInput/CreateSaleUseCase input.
export interface CreateInventoryItemInput {
  name: string;
  sku?: string;
  unit: string;
  minStock?: number;
  notes?: string;
}

@Injectable()
export class CreateInventoryItemUseCase {
  constructor(
    @Inject(INVENTORY_REPOSITORY)
    private readonly repo: InventoryRepository,
  ) {}

  async execute(
    input: CreateInventoryItemInput,
    createdById?: string,
  ): Promise<InventoryItem> {
    const name = input.name.trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }

    const unit = input.unit.trim();
    if (!unit) {
      throw new BadRequestException('unit is required');
    }

    // Omitted → default 0, same "resolve the default before it reaches the
    // repository" convention as AddTreatmentPlanItemUseCase resolving price.
    const minStock = input.minStock ?? 0;
    if (!Number.isFinite(minStock) || minStock < 0) {
      throw new BadRequestException('minStock must be a number >= 0');
    }

    const sku = input.sku?.trim();

    return this.repo.createItem({
      name,
      sku: sku ? sku : undefined,
      unit,
      minStock,
      notes: input.notes,
      createdById,
    });
  }
}
