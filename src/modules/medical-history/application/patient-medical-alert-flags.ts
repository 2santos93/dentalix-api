import { Inject, Injectable } from '@nestjs/common';
import {
  NO_ANAMNESIS_FLAGS,
  deriveMedicalAlertFlags,
  type MedicalAlertFlags,
} from '../domain/medical-alert-flags';
import {
  MEDICAL_ALERTS_REPOSITORY,
  type MedicalAlertsRepository,
} from '../domain/ports/medical-alerts-repository.port';

export const MEDICAL_ALERTS_CLOCK = Symbol('MEDICAL_ALERTS_CLOCK');

/**
 * Banderas médicas de un LOTE de pacientes (DX-247, molde
 * `PatientCoverageFlags`): la agenda y el panel «En clínica» las piden para
 * todos a la vez. A lo sumo DOS consultas, sin importar cuántos ids lleguen: la
 * vigencia de la clínica y la versión vigente + última confirmación de cada
 * paciente. Solo banderas: nunca la historia.
 */
@Injectable()
export class PatientMedicalAlertFlags {
  constructor(
    @Inject(MEDICAL_ALERTS_REPOSITORY)
    private readonly repo: MedicalAlertsRepository,
    @Inject(MEDICAL_ALERTS_CLOCK) private readonly now: () => Date,
  ) {}

  async forPatients(
    patientIds: readonly string[],
  ): Promise<Map<string, MedicalAlertFlags>> {
    const ids = [...new Set(patientIds)];
    const out = new Map<string, MedicalAlertFlags>();
    if (ids.length === 0) return out;
    const [states, validityMonths] = await Promise.all([
      this.repo.reviewStates(ids),
      this.repo.getValidityMonths(),
    ]);
    const now = this.now();
    for (const id of ids) {
      const state = states.get(id);
      out.set(
        id,
        state
          ? deriveMedicalAlertFlags(
              state.snapshot,
              state.lastConfirmedAt,
              validityMonths,
              now,
            )
          : NO_ANAMNESIS_FLAGS,
      );
    }
    return out;
  }

  async forPatient(patientId: string): Promise<MedicalAlertFlags> {
    const map = await this.forPatients([patientId]);
    return map.get(patientId) ?? NO_ANAMNESIS_FLAGS;
  }
}
