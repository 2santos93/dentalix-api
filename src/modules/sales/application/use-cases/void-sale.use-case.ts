import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { SALE_REPOSITORY } from '../../domain/ports/sale-repository.port';
import type { SaleRepository } from '../../domain/ports/sale-repository.port';

@Injectable()
export class VoidSaleUseCase {
  constructor(
    @Inject(SALE_REPOSITORY)
    private readonly repo: SaleRepository,
  ) {}

  async execute(id: string): Promise<void> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      throw new NotFoundException('Sale not found');
    }

    // Soft-delete only — never a hard delete on a domain table. A voided
    // sale is a financial record too: it must remain queryable for audit,
    // just excluded from active lists/totals via `deletedAt: null`.
    await this.repo.softDelete(id);
  }
}
