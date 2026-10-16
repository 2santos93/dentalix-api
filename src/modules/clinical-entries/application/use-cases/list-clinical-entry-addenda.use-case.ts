import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CLINICAL_ENTRY_ADDENDUM_REPOSITORY } from '../../domain/ports/clinical-entry-addendum-repository.port';
import type { ClinicalEntryAddendumRepository } from '../../domain/ports/clinical-entry-addendum-repository.port';
import { ClinicalEntryAddendum } from '../../domain/entities/clinical-entry-addendum.entity';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';
import { CLINICAL_ENTRY_NOT_FOUND_MESSAGE } from '../clinical-record-errors';

@Injectable()
export class ListClinicalEntryAddendaUseCase {
  constructor(
    @Inject(CLINICAL_ENTRY_ADDENDUM_REPOSITORY)
    private readonly repo: ClinicalEntryAddendumRepository,
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
  ) {}

  /** Adendas de la evolución en orden cronológico; 404 si no es del paciente. */
  async execute(
    patientId: string,
    entryId: string,
  ): Promise<ClinicalEntryAddendum[]> {
    await assertPatientInClinic(this.patients, patientId);
    if (!(await this.repo.entryExists(patientId, entryId))) {
      throw new NotFoundException(CLINICAL_ENTRY_NOT_FOUND_MESSAGE);
    }
    return this.repo.listByEntry(patientId, entryId);
  }
}
