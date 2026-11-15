import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PATIENT_REPOSITORY } from '../../domain/ports/patient-repository.port';
import type { PatientRepository } from '../../domain/ports/patient-repository.port';
import { Patient } from '../../domain/entities/patient.entity';

/** DX-266: código del 404 de un paciente absorbido por una fusión. */
export const PATIENT_MERGED = 'PATIENT_MERGED';
export const PATIENT_MERGED_MESSAGE =
  'Este paciente se fusionó con otro; su ficha es ahora la del paciente que se conservó.';

@Injectable()
export class GetPatientUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly repo: PatientRepository,
  ) {}

  async execute(id: string): Promise<Patient> {
    const patient = await this.repo.findById(id);
    if (!patient) {
      // DX-266: un absorbido por una fusión responde 404 con el paciente que
      // se conserva, para que la ficha antigua lleve a él.
      const mergedIntoId = (await this.repo.findMergedInto?.(id)) ?? null;
      if (mergedIntoId) {
        throw new NotFoundException({
          statusCode: 404,
          error: 'Not Found',
          code: PATIENT_MERGED,
          message: PATIENT_MERGED_MESSAGE,
          mergedIntoId,
        });
      }
      // A missing repo result is indistinguishable from "exists but belongs
      // to another tenant" — RLS makes cross-tenant rows invisible, so both
      // cases surface as NotFound here (never leak that the row exists).
      throw new NotFoundException('Paciente no encontrado');
    }
    return patient;
  }
}
