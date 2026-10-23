import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CLINICAL_ENTRY_REPOSITORY,
  type ClinicalEntryRepository,
} from '../../domain/ports/clinical-entry-repository.port';
import {
  PATIENT_REPOSITORY,
  type PatientRepository,
} from '../../../patients/domain/ports/patient-repository.port';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';
import {
  computeRdaReadiness,
  type RdaReadiness,
} from '../../domain/rda-readiness';
import { RDA_ENTRY_NOT_FOUND_MESSAGE } from './get-rda-readiness.use-case';

export type BatchRdaReadiness = RdaReadiness & { entryId: string };

@Injectable()
export class GetBatchRdaReadinessUseCase {
  constructor(
    @Inject(CLINICAL_ENTRY_REPOSITORY)
    private readonly repo: ClinicalEntryRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
  ) {}

  async execute(
    patientId: string,
    ids: string[],
  ): Promise<BatchRdaReadiness[]> {
    if (ids.length === 0 || ids.length > 50) {
      throw new BadRequestException('Envía entre 1 y 50 evoluciones');
    }
    await assertPatientInClinic(this.patients, patientId);
    // UUID PostgreSQL se representa en minúsculas, aunque la entrada válida
    // use mayúsculas. El límite anterior cuenta entradas, antes de deduplicar.
    const uniqueIds = [...new Set(ids.map((id) => id.toLowerCase()))];
    const facts = await this.repo.loadRdaFactsBatch(uniqueIds, patientId);
    if (uniqueIds.some((id) => !facts.has(id))) {
      throw new NotFoundException(RDA_ENTRY_NOT_FOUND_MESSAGE);
    }
    return uniqueIds.map((entryId) => ({
      entryId,
      ...computeRdaReadiness(facts.get(entryId)!),
    }));
  }
}
