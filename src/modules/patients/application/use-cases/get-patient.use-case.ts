import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PATIENT_REPOSITORY } from '../../domain/ports/patient-repository.port';
import type { PatientRepository } from '../../domain/ports/patient-repository.port';
import { Patient } from '../../domain/entities/patient.entity';

@Injectable()
export class GetPatientUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly repo: PatientRepository,
  ) {}

  async execute(id: string): Promise<Patient> {
    const patient = await this.repo.findById(id);
    if (!patient) {
      // A missing repo result is indistinguishable from "exists but belongs
      // to another tenant" — RLS makes cross-tenant rows invisible, so both
      // cases surface as NotFound here (never leak that the row exists).
      throw new NotFoundException('Patient not found');
    }
    return patient;
  }
}
