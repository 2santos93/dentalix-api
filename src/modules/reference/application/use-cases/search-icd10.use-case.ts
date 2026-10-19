import { Inject, Injectable } from '@nestjs/common';
import { REFERENCE_REPOSITORY } from '../../domain/ports/reference-repository.port';
import type { ReferenceRepository } from '../../domain/ports/reference-repository.port';
import { Icd10Code } from '../../domain/entities/icd10-code.entity';

/** Tope fijo de la búsqueda CIE-10 (DX-212): un combobox, no un listado. */
export const ICD10_SEARCH_LIMIT = 20;

@Injectable()
export class SearchIcd10UseCase {
  constructor(
    @Inject(REFERENCE_REPOSITORY)
    private readonly repo: ReferenceRepository,
  ) {}

  execute(q: string | undefined): Promise<Icd10Code[]> {
    return this.repo.searchIcd10(q, ICD10_SEARCH_LIMIT);
  }
}
