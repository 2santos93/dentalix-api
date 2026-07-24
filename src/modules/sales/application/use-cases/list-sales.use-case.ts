import { Inject, Injectable } from '@nestjs/common';
import { SALE_REPOSITORY } from '../../domain/ports/sale-repository.port';
import type { SaleRepository } from '../../domain/ports/sale-repository.port';
import { Sale } from '../../domain/entities/sale.entity';

export interface ListSalesInput {
  from?: Date;
  to?: Date;
  patientId?: string;
}

@Injectable()
export class ListSalesUseCase {
  constructor(
    @Inject(SALE_REPOSITORY)
    private readonly repo: SaleRepository,
  ) {}

  /**
   * Ordering (`paidAt` DESC) and the active/`deletedAt:null` filter are the
   * repository's responsibility (see `PrismaSaleRepository` / the in-memory
   * fake in the spec for the same contract) — this use case only forwards
   * the optional range + patient filter untouched.
   */
  async execute(input: ListSalesInput = {}): Promise<Sale[]> {
    return this.repo.listByRange({
      from: input.from,
      to: input.to,
      patientId: input.patientId,
    });
  }
}
