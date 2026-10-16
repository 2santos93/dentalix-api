import { Inject, Injectable } from '@nestjs/common';
import { DATA_CONSENT_REPOSITORY } from '../../domain/ports/data-consent-repository.port';
import type { DataConsentRepository } from '../../domain/ports/data-consent-repository.port';
import type {
  ConsentDecision,
  ConsentEvidence,
  PatientDataConsents,
} from '../../domain/entities/data-consent.entity';
import {
  assertValidDecisions,
  currentConsentByScope,
  sortHistory,
} from '../../domain/consent-state';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';

export interface RecordDataConsentsInput {
  policyVersionId: string;
  decisions: ConsentDecision[];
}

@Injectable()
export class RecordDataConsentsUseCase {
  constructor(
    @Inject(DATA_CONSENT_REPOSITORY)
    private readonly repo: DataConsentRepository,
    // Bajo RLS: un paciente de otra clínica da 404 antes de insertar (SEC-004).
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
  ) {}

  /**
   * Registra aceptaciones o revocaciones (append-only) y devuelve el estado
   * resultante. Las filas llevan la hora del servidor, quién las registró y la
   * IP / user-agent de la petición.
   */
  async execute(
    patientId: string,
    input: RecordDataConsentsInput,
    recordedById: string,
    evidence: ConsentEvidence,
  ): Promise<PatientDataConsents> {
    assertValidDecisions(input.decisions);
    await assertPatientInClinic(this.patients, patientId);
    await this.repo.record({
      patientId,
      policyVersionId: input.policyVersionId,
      decisions: input.decisions.map((d) => ({
        scope: d.scope,
        granted: d.granted,
      })),
      recordedById,
      evidence,
    });
    const history = sortHistory(await this.repo.listForPatient(patientId));
    return { current: currentConsentByScope(history), history };
  }
}
