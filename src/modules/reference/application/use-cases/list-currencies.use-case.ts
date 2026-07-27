import { Inject, Injectable } from '@nestjs/common';
import { REFERENCE_REPOSITORY } from '../../domain/ports/reference-repository.port';
import type { ReferenceRepository } from '../../domain/ports/reference-repository.port';
import { Currency } from '../../domain/entities/currency.entity';

@Injectable()
export class ListCurrenciesUseCase {
  constructor(
    @Inject(REFERENCE_REPOSITORY)
    private readonly repo: ReferenceRepository,
  ) {}

  execute(): Promise<Currency[]> {
    return this.repo.listCurrencies();
  }
}
