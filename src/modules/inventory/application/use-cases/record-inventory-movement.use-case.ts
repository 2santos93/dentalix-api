import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryMovementType } from '@prisma/client';
import { INVENTORY_REPOSITORY } from '../../domain/ports/inventory-repository.port';
import type { InventoryRepository } from '../../domain/ports/inventory-repository.port';
import { InventoryMovement } from '../../domain/entities/inventory-movement.entity';

// NOTE: deliberately NO `tenantId`/`id`/`occurredAt` field — tenant from
// context, `occurredAt` defaults to `now()` at the schema level.
export interface RecordInventoryMovementInput {
  itemId: string;
  type: InventoryMovementType;
  quantity: number;
  reason?: string;
}

@Injectable()
export class RecordInventoryMovementUseCase {
  constructor(
    @Inject(INVENTORY_REPOSITORY)
    private readonly repo: InventoryRepository,
  ) {}

  /**
   * v1 deliberately ALLOWS the resulting stock to go negative (e.g. an OUT
   * larger than what is on hand, recording a shrinkage/mismatch) — see the
   * plan's "Notas" and `signedQuantity`'s doc comment. This use case does
   * NOT read the current stock before persisting; it only validates the
   * shape of the movement itself. Blocking negative stock is an explicit
   * follow-up (config-gated), not this version's behavior.
   */
  async execute(
    input: RecordInventoryMovementInput,
    createdById?: string,
  ): Promise<InventoryMovement> {
    const item = await this.repo.findItemById(input.itemId);
    if (!item) {
      throw new NotFoundException('Inventory item not found');
    }

    if (
      (input.type === InventoryMovementType.IN ||
        input.type === InventoryMovementType.OUT) &&
      !(input.quantity > 0)
    ) {
      throw new BadRequestException(
        'quantity must be > 0 for IN/OUT movements',
      );
    }

    if (
      input.type === InventoryMovementType.ADJUSTMENT &&
      input.quantity === 0
    ) {
      throw new BadRequestException(
        'quantity must be != 0 for ADJUSTMENT movements',
      );
    }

    return this.repo.createMovement({
      itemId: input.itemId,
      type: input.type,
      quantity: input.quantity,
      reason: input.reason,
      createdById,
    });
  }
}
