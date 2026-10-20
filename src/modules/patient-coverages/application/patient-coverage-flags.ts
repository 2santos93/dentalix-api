import { Inject, Injectable } from '@nestjs/common';
import { coverageStatus } from '../domain/coverage-rules';
import {
  PATIENT_COVERAGE_REPOSITORY,
  type PatientCoverageRepository,
} from '../domain/ports/patient-coverage-repository.port';
import { COVERAGES_CLOCK } from './use-cases/patient-coverages.use-cases';

/**
 * Resumen de la cobertura de un paciente (DX-153), calculado sobre su
 * cobertura PRINCIPAL viva. Nunca lleva el número de afiliado.
 */
export interface CoverageSummary {
  status: 'NONE' | 'ACTIVE' | 'EXPIRED' | 'NOT_STARTED';
  payerName: string | null;
  planName: string | null;
  /** Día civil `YYYY-MM-DD`, o `null` si la vigencia es indefinida. */
  validTo: string | null;
}

export const NO_COVERAGE: CoverageSummary = {
  status: 'NONE',
  payerName: null,
  planName: null,
  validTo: null,
};

/**
 * Resumen de cobertura de un LOTE de pacientes (molde `PatientBalanceFlags`,
 * DX-150): la agenda y el listado lo piden para todos a la vez. A lo sumo DOS
 * consultas, sin importar cuántos ids lleguen: las coberturas principales vivas
 * con el nombre del pagador y el día civil de hoy en la zona de la sede.
 */
@Injectable()
export class PatientCoverageFlags {
  constructor(
    @Inject(PATIENT_COVERAGE_REPOSITORY)
    private readonly repo: PatientCoverageRepository,
    @Inject(COVERAGES_CLOCK) private readonly now: () => Date,
  ) {}

  async forPatients(
    patientIds: readonly string[],
  ): Promise<Map<string, CoverageSummary>> {
    const out = new Map<string, CoverageSummary>();
    const ids = [...new Set(patientIds)];
    for (const id of ids) out.set(id, NO_COVERAGE);
    if (ids.length === 0) return out;
    const rows = await this.repo.listPrimaryLiveByPatients(ids);
    if (rows.length === 0) return out;
    const today = await this.repo.clinicToday(this.now());
    for (const row of rows) {
      out.set(row.patientId, {
        status: coverageStatus(row, today),
        payerName: row.payerName,
        planName: row.planName,
        validTo: row.validTo,
      });
    }
    return out;
  }

  async forPatient(patientId: string): Promise<CoverageSummary> {
    const map = await this.forPatients([patientId]);
    return map.get(patientId) ?? NO_COVERAGE;
  }
}
