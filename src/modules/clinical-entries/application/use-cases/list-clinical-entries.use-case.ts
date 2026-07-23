import { Inject, Injectable } from '@nestjs/common';
import { CLINICAL_ENTRY_REPOSITORY } from '../../domain/ports/clinical-entry-repository.port';
import type {
  ClinicalEntryRepository,
  ListClinicalEntriesParams,
} from '../../domain/ports/clinical-entry-repository.port';
import { ClinicalEntry } from '../../domain/entities/clinical-entry.entity';

@Injectable()
export class ListClinicalEntriesUseCase {
  constructor(
    @Inject(CLINICAL_ENTRY_REPOSITORY)
    private readonly repo: ClinicalEntryRepository,
  ) {}

  /**
   * Ordering (entryDate DESC) and range filtering are the repository's
   * responsibility (see PrismaClinicalEntryRepository / the in-memory fake
   * in the spec for the same contract) — this use case only forwards the
   * patientId + optional from/to range untouched.
   */
  async execute(
    patientId: string,
    params?: ListClinicalEntriesParams,
  ): Promise<ClinicalEntry[]> {
    return this.repo.listByPatient(patientId, params);
  }
}
