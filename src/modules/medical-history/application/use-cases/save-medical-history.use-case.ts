import { Inject, Injectable } from '@nestjs/common';
import { MEDICAL_HISTORY_REPOSITORY } from '../../domain/ports/medical-history-repository.port';
import type {
  MedicalHistoryRepository,
  MedicalHistoryVersionData,
} from '../../domain/ports/medical-history-repository.port';
import { MedicalHistory } from '../../domain/entities/medical-history.entity';

// NOTE: deliberately NO `tenantId`/`version`/`id` fields — same rationale as
// MedicalHistoryVersionData (tenant from context, version computed by the
// repository). This is the shape the controller's DTO maps into.
export type SaveMedicalHistoryInput = MedicalHistoryVersionData;

@Injectable()
export class SaveMedicalHistoryUseCase {
  constructor(
    @Inject(MEDICAL_HISTORY_REPOSITORY)
    private readonly repo: MedicalHistoryRepository,
  ) {}

  /**
   * Append-only: ALWAYS creates a brand-new version via
   * `repo.createVersion` — never looks up or updates an existing row. The
   * repository computes `version = latest+1`; the previous version is left
   * completely untouched (see PrismaMedicalHistoryRepository /
   * InMemoryMedicalHistoryRepository in the spec for the same contract).
   */
  async execute(
    patientId: string,
    data: MedicalHistoryVersionData,
    createdById?: string,
  ): Promise<MedicalHistory> {
    // Rebuild the payload from only the known fields — same defensive
    // convention as CreateCatalogItemUseCase: anything sneaked into `data`
    // beyond this shape (e.g. a client-supplied `tenantId`/`version`) is
    // dropped here, never forwarded to the repository.
    const normalized: MedicalHistoryVersionData = {
      allergies: data.allergies,
      chronicConditions: data.chronicConditions,
      currentMedications: data.currentMedications,
      habits: data.habits,
      medicalAlerts: data.medicalAlerts,
      notes: data.notes,
    };

    return this.repo.createVersion(patientId, normalized, createdById);
  }
}
