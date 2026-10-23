import { Inject, Injectable } from '@nestjs/common';
import {
  patientAgreementStatus,
  type PatientAgreementStatus,
} from '../domain/patient-agreement-rules';
import {
  PATIENT_AGREEMENT_REPOSITORY,
  type PatientAgreementRepository,
} from '../domain/ports/patient-agreement-repository.port';
import { PATIENT_AGREEMENTS_CLOCK } from './use-cases/patient-agreements.use-cases';

/** Resumen del convenio vigente de un paciente (DX-105). */
export interface AgreementSummary {
  status: 'NONE' | PatientAgreementStatus;
  agreementName: string | null;
  payerName: string | null;
}

export const NO_AGREEMENT: AgreementSummary = {
  status: 'NONE',
  agreementName: null,
  payerName: null,
};

/**
 * Resumen del convenio de un LOTE de pacientes (molde `PatientCoverageFlags`).
 * A lo sumo DOS consultas, sin importar cuántos ids lleguen: las asignaciones
 * vivas con convenio y pagador, y el día civil de hoy en la zona de la sede.
 */
@Injectable()
export class PatientAgreementFlags {
  constructor(
    @Inject(PATIENT_AGREEMENT_REPOSITORY)
    private readonly repo: PatientAgreementRepository,
    @Inject(PATIENT_AGREEMENTS_CLOCK) private readonly now: () => Date,
  ) {}

  async forPatients(
    patientIds: readonly string[],
  ): Promise<Map<string, AgreementSummary>> {
    const out = new Map<string, AgreementSummary>();
    const ids = [...new Set(patientIds)];
    for (const id of ids) out.set(id, NO_AGREEMENT);
    if (ids.length === 0) return out;
    const rows = await this.repo.listCurrentByPatients(ids);
    if (rows.length === 0) return out;
    const today = await this.repo.clinicToday(this.now());
    for (const row of rows) {
      out.set(row.patientId, {
        status: patientAgreementStatus(
          {
            agreement: {
              active: row.agreementActive,
              validFrom: row.agreementValidFrom,
              validTo: row.agreementValidTo,
            },
            validFrom: row.validFrom,
            validTo: row.validTo,
          },
          today,
        ),
        agreementName: row.agreementName,
        payerName: row.payerName,
      });
    }
    return out;
  }

  async forPatient(patientId: string): Promise<AgreementSummary> {
    const map = await this.forPatients([patientId]);
    return map.get(patientId) ?? NO_AGREEMENT;
  }
}
