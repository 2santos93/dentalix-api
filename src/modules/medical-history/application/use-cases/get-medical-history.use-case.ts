import { Inject, Injectable } from '@nestjs/common';
import { MEDICAL_HISTORY_REPOSITORY } from '../../domain/ports/medical-history-repository.port';
import type { MedicalHistoryRepository } from '../../domain/ports/medical-history-repository.port';
import { MedicalHistory } from '../../domain/entities/medical-history.entity';

@Injectable()
export class GetMedicalHistoryUseCase {
  constructor(
    @Inject(MEDICAL_HISTORY_REPOSITORY)
    private readonly repo: MedicalHistoryRepository,
  ) {}

  /**
   * Unlike GetPatientUseCase, an absent medical history is NOT an error: a
   * patient legitimately has no anamnesis yet (first visit). The caller
   * (controller) returns this as 200 + null, never a 404.
   */
  async execute(patientId: string): Promise<MedicalHistory | null> {
    return this.repo.getLatest(patientId);
  }
}
