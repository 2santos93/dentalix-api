import { Inject, Injectable } from '@nestjs/common';
import { PATIENT_REPOSITORY } from '../../domain/ports/patient-repository.port';
import type { PatientRepository } from '../../domain/ports/patient-repository.port';

/**
 * Número de pacientes vivos de la clínica (DX-043, DB-008). Es un COUNT: quien
 * solo necesita el número (el dashboard) no paga una página de pacientes.
 */
@Injectable()
export class CountPatientsUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly repo: PatientRepository,
  ) {}

  execute(): Promise<number> {
    return this.repo.count();
  }
}
