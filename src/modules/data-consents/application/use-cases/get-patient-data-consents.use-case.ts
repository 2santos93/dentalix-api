import { Inject, Injectable } from '@nestjs/common';
import { DATA_CONSENT_REPOSITORY } from '../../domain/ports/data-consent-repository.port';
import type { DataConsentRepository } from '../../domain/ports/data-consent-repository.port';
import type { PatientDataConsents } from '../../domain/entities/data-consent.entity';
import { currentConsentByScope, sortHistory } from '../../domain/consent-state';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';

@Injectable()
export class GetPatientDataConsentsUseCase {
  constructor(
    @Inject(DATA_CONSENT_REPOSITORY)
    private readonly repo: DataConsentRepository,
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
  ) {}

  async execute(patientId: string): Promise<PatientDataConsents> {
    // 404 limpio para un paciente de otra clínica, en vez de "sin filas".
    await assertPatientInClinic(this.patients, patientId);
    const history = sortHistory(await this.repo.listForPatient(patientId));
    return { current: currentConsentByScope(history), history };
  }
}
