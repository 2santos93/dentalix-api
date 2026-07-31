import { Inject, Injectable } from '@nestjs/common';
import { MEDICAL_HISTORY_REPOSITORY } from '../../domain/ports/medical-history-repository.port';
import type {
  MedicalHistoryRepository,
  MedicalHistoryVersionData,
} from '../../domain/ports/medical-history-repository.port';
import { MedicalHistory } from '../../domain/entities/medical-history.entity';

// NOTE: deliberately NO `tenantId`/`version`/`id`/`safetyFlags`/
// `hasCriticalAlert` fields — same rationale as MedicalHistoryVersionData
// (tenant from context, version computed by the repository, flags derived in
// the domain). This is the shape the controller's DTO maps into.
export type SaveMedicalHistoryInput = MedicalHistoryVersionData;

@Injectable()
export class SaveMedicalHistoryUseCase {
  constructor(
    @Inject(MEDICAL_HISTORY_REPOSITORY)
    private readonly repo: MedicalHistoryRepository,
  ) {}

  /**
   * Append-only: siempre crea una versión nueva. Reconstruye el payload solo
   * con los campos conocidos (defensivo: descarta cualquier `tenantId`/
   * `version`/`safetyFlags` colado en `data`). La derivación de banderas vive
   * en el repositorio (`deriveSafetyFlags`), junto al INSERT, para que el
   * cómputo sea la única fuente de verdad tanto aquí como en el alta.
   */
  async execute(
    patientId: string,
    data: MedicalHistoryVersionData,
    createdById?: string,
  ): Promise<MedicalHistory> {
    const normalized: MedicalHistoryVersionData = {
      allergies: data.allergies,
      conditions: data.conditions,
      medications: data.medications,
      habits: data.habits,
      dentalHistory: data.dentalHistory,
      surgeries: data.surgeries,
      vitalSigns: data.vitalSigns,
      familyHistory: data.familyHistory,
      notes: data.notes,
      embarazo: data.embarazo,
      semanasEmbarazo: data.semanasEmbarazo,
    };
    return this.repo.createVersion(patientId, normalized, createdById);
  }
}
