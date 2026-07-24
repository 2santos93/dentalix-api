import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { SALE_REPOSITORY } from '../../domain/ports/sale-repository.port';
import type { SaleRepository } from '../../domain/ports/sale-repository.port';
import { SaleWithLineItems } from '../../domain/entities/sale.entity';

@Injectable()
export class GetSaleUseCase {
  constructor(
    @Inject(SALE_REPOSITORY)
    private readonly repo: SaleRepository,
  ) {}

  async execute(id: string): Promise<SaleWithLineItems> {
    const sale = await this.repo.findById(id);
    if (!sale) {
      // Same rationale as GetTreatmentPlanUseCase: a missing row and a row
      // that belongs to another tenant are indistinguishable here (RLS makes
      // cross-tenant rows invisible), so both surface as NotFound.
      throw new NotFoundException('Sale not found');
    }
    return sale;
  }
}
