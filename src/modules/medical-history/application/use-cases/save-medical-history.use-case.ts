import { Inject, Injectable } from '@nestjs/common';
import { MEDICAL_HISTORY_REPOSITORY } from '../../domain/ports/medical-history-repository.port';
import type { MedicalHistoryRepository } from '../../domain/ports/medical-history-repository.port';
import {
  toVersionData,
  type MedicalHistoryInput,
} from '../../domain/anamnesis-answers';
import { MedicalHistory } from '../../domain/entities/medical-history.entity';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';
import {
  idempotencyRequest,
  idempotentCreate,
  type IdempotencySignals,
} from '../../../../shared/validation/idempotent-create';

/** DX-574: 422 de una Idempotency-Key repetida con otra anamnesis. */
export const ANAMNESIS_IDEMPOTENCY_KEY_REUSED_MESSAGE =
  'Esta anamnesis ya se guardó con otras respuestas. Revisa la versión vigente antes de volver a intentarlo.';

// NOTE: deliberately NO `tenantId`/`version`/`id`/`safetyFlags`/
// `hasCriticalAlert` fields — same rationale as MedicalHistoryVersionData
// (tenant from context, version computed by the repository, flags derived in
// the domain). This is the shape the controller's DTO maps into.
// Acepta también la forma de un cliente anterior (`embarazo`, hábitos
// booleanos): `toVersionData` la traduce.
export type SaveMedicalHistoryInput = MedicalHistoryInput;

@Injectable()
export class SaveMedicalHistoryUseCase {
  constructor(
    @Inject(MEDICAL_HISTORY_REPOSITORY)
    private readonly repo: MedicalHistoryRepository,
    // Resuelve "¿este paciente es de ESTA clínica?" bajo RLS antes de insertar
    // (SEC-004): la FK a patients se chequea saltando la RLS, así que sin esto
    // se podía escribir contra un paciente de otra clínica.
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
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
    data: MedicalHistoryInput,
    createdById?: string,
    idempotency?: { idempotencyKey?: string; signals?: IdempotencySignals },
  ): Promise<MedicalHistory> {
    // DX-574: cada guardado añade una versión, así que un reintento tras un
    // corte de red con la misma clave devuelve la que ya guardó.
    const request = idempotencyRequest(idempotency?.idempotencyKey, [
      'MEDICAL_HISTORY',
      patientId,
      data,
    ]);
    return idempotentCreate(request, {
      find: (key) => this.repo.findByIdempotencyKey(key),
      create: async () => {
        await assertPatientInClinic(this.patients, patientId);
        const normalized = toVersionData(data);
        return this.repo.createVersion(
          patientId,
          normalized,
          createdById,
          request,
        );
      },
      reusedMessage: ANAMNESIS_IDEMPOTENCY_KEY_REUSED_MESSAGE,
      signals: idempotency?.signals,
    });
  }
}
