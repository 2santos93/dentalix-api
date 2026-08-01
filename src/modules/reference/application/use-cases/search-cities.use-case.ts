import { Inject, Injectable } from '@nestjs/common';
import { REFERENCE_REPOSITORY } from '../../domain/ports/reference-repository.port';
import type { ReferenceRepository } from '../../domain/ports/reference-repository.port';
import { City } from '../../domain/entities/city.entity';

export interface SearchCitiesInput {
  countryCode: string;
  q?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

@Injectable()
export class SearchCitiesUseCase {
  constructor(
    @Inject(REFERENCE_REPOSITORY)
    private readonly repo: ReferenceRepository,
  ) {}

  execute(input: SearchCitiesInput): Promise<City[]> {
    const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    return this.repo.searchCities(
      input.countryCode.toUpperCase(),
      input.q,
      limit,
    );
  }
}
