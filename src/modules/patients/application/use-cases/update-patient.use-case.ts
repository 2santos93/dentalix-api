import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PATIENT_REPOSITORY } from '../../domain/ports/patient-repository.port';
import type {
  PatientRepository,
  UpdatePatientRepoInput,
} from '../../domain/ports/patient-repository.port';
import { Patient } from '../../domain/entities/patient.entity';

export type UpdatePatientInput = UpdatePatientRepoInput;

@Injectable()
export class UpdatePatientUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly repo: PatientRepository,
  ) {}

  async execute(id: string, patch: UpdatePatientInput): Promise<Patient> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      // Same rationale as GetPatientUseCase: a missing row and a row that
      // belongs to another tenant are indistinguishable here (RLS makes
      // cross-tenant rows invisible), so both surface as NotFound.
      throw new NotFoundException('Patient not found');
    }

    const normalizedPatch: UpdatePatientRepoInput = { ...patch };
    if (normalizedPatch.email) {
      normalizedPatch.email = normalizedPatch.email.trim().toLowerCase();
    }

    return this.repo.update(id, normalizedPatch);
  }
}
