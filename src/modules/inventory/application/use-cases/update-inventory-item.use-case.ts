import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { INVENTORY_REPOSITORY } from '../../domain/ports/inventory-repository.port';
import type { InventoryRepository } from '../../domain/ports/inventory-repository.port';
import { InventoryItem } from '../../domain/entities/inventory-item.entity';
import { INVENTORY_AUDITED_WRITES } from '../../domain/ports/inventory-audited-writes.port';
import type { InventoryAuditedWrites } from '../../domain/ports/inventory-audited-writes.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { toInventoryNameConflict } from '../inventory-name-conflict';

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
    @Inject(INVENTORY_AUDITED_WRITES)
    private readonly writes: InventoryAuditedWrites,
  ) {}

  async execute(
    id: string,
    input: UpdateInventoryItemInput,
    audit: AuditRequestContext,
  ): Promise<InventoryItem> {
    const existing = await this.repo.findItemById(id);
    if (!existing) {
      // Same rationale as UpdateTreatmentPlanUseCase: a missing row and a
      // row that belongs to another tenant are indistinguishable here (RLS
      // makes cross-tenant rows invisible), so both surface as NotFound.
      throw new NotFoundException('Insumo no encontrado');
    }

    let name: string | undefined;
    if (input.name !== undefined) {
      name = input.name.trim();
      if (!name) {
        throw new BadRequestException('El nombre es obligatorio.');
      }
    }

    let unit: string | undefined;
    if (input.unit !== undefined) {
      unit = input.unit.trim();
      if (!unit) {
        throw new BadRequestException('La unidad es obligatoria.');
      }
    }

    if (
      input.minStock !== undefined &&
      (!Number.isFinite(input.minStock) || input.minStock < 0)
    ) {
      throw new BadRequestException(
        'El stock mínimo debe ser un número mayor o igual a 0.',
      );
    }

    try {
      return await this.writes.updateItem(
        id,
        {
          name,
          sku: input.sku,
          unit,
          minStock: input.minStock,
          notes: input.notes,
        },
        audit,
      );
    } catch (error) {
      throw toInventoryNameConflict(error);
    }
  }
}
