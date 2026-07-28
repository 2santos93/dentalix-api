import { Inject, Injectable } from '@nestjs/common';
import { REFERENCE_REPOSITORY } from '../../domain/ports/reference-repository.port';
import type { ReferenceRepository } from '../../domain/ports/reference-repository.port';
import { Country } from '../../domain/entities/country.entity';

@Injectable()
export class ListCountriesUseCase {
  constructor(
    @Inject(REFERENCE_REPOSITORY)
    private readonly repo: ReferenceRepository,
  ) {}

  execute(): Promise<Country[]> {
    return this.repo.listCountries();
  }
}
