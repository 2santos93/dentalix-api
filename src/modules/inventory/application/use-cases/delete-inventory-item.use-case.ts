import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { INVENTORY_REPOSITORY } from '../../domain/ports/inventory-repository.port';
import type { InventoryRepository } from '../../domain/ports/inventory-repository.port';
import { INVENTORY_AUDITED_WRITES } from '../../domain/ports/inventory-audited-writes.port';
import type { InventoryAuditedWrites } from '../../domain/ports/inventory-audited-writes.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

@Injectable()
export class DeleteInventoryItemUseCase {
  constructor(
    @Inject(INVENTORY_REPOSITORY)
    private readonly repo: InventoryRepository,
    @Inject(INVENTORY_AUDITED_WRITES)
    private readonly writes: InventoryAuditedWrites,
  ) {}

  async execute(id: string, audit: AuditRequestContext): Promise<void> {
    const existing = await this.repo.findItemById(id);
    if (!existing) {
      throw new NotFoundException('Inventory item not found');
    }

    // Soft-delete only — never a hard delete on a domain table. Movements
    // are untouched (they are immutable history, independent of the item's
    // lifecycle).
    await this.writes.softDeleteItem(id, audit);
  }
}
