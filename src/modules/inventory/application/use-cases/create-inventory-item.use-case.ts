import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { INVENTORY_AUDITED_WRITES } from '../../domain/ports/inventory-audited-writes.port';
import type { InventoryAuditedWrites } from '../../domain/ports/inventory-audited-writes.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { InventoryItem } from '../../domain/entities/inventory-item.entity';
import { toInventoryNameConflict } from '../inventory-name-conflict';

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
    @Inject(INVENTORY_AUDITED_WRITES)
    private readonly writes: InventoryAuditedWrites,
  ) {}

  async execute(
    input: CreateInventoryItemInput,
    audit: AuditRequestContext,
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

    try {
      return await this.writes.createItem(
        {
          name,
          sku: sku ? sku : undefined,
          unit,
          minStock,
          notes: input.notes,
        },
        audit,
      );
    } catch (error) {
      throw toInventoryNameConflict(error);
    }
  }
}
