import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CLINICAL_ENTRY_ADDENDUM_REPOSITORY } from '../../domain/ports/clinical-entry-addendum-repository.port';
import type { ClinicalEntryAddendumRepository } from '../../domain/ports/clinical-entry-addendum-repository.port';
import { ClinicalEntryAddendum } from '../../domain/entities/clinical-entry-addendum.entity';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';
import {
  assertAuthor,
  CLINICAL_ENTRY_NOT_FOUND_MESSAGE,
} from '../clinical-record-errors';

export { CLINICAL_ENTRY_NOT_FOUND_MESSAGE };

/** Topes compartidos con el DTO y con los CHECK de la tabla. */
export const ADDENDUM_REASON_MIN = 10;
export const ADDENDUM_REASON_MAX = 500;
export const ADDENDUM_TEXT_MAX = 5000;

// Sin autor, fecha ni tenant: el autor llega aparte desde `req.user.sub` y la
// fecha la pone la BD.
export interface CreateClinicalEntryAddendumInput {
  reason: string;
  text: string;
}

@Injectable()
export class CreateClinicalEntryAddendumUseCase {
  constructor(
    @Inject(CLINICAL_ENTRY_ADDENDUM_REPOSITORY)
    private readonly repo: ClinicalEntryAddendumRepository,
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
  ) {}

  /**
   * Corrige una evolución con una nota aclaratoria (Res. 1995/1999 art. 18):
   * siempre INSERTA; el original no se toca. Paciente de otra clínica o
   * evolución de otro paciente → el mismo 404, sin revelar si existe.
   */
  async execute(
    patientId: string,
    entryId: string,
    input: CreateClinicalEntryAddendumInput,
    authorId: string,
  ): Promise<ClinicalEntryAddendum> {
    const author = assertAuthor(authorId);
    const reason = input.reason.trim();
    const text = input.text.trim();
    if (reason.length < ADDENDUM_REASON_MIN) {
      throw new BadRequestException(
        `El motivo de la adenda debe tener al menos ${ADDENDUM_REASON_MIN} caracteres`,
      );
    }
    if (text === '') {
      throw new BadRequestException(
        'El texto de la adenda no puede estar vacío',
      );
    }

    await assertPatientInClinic(this.patients, patientId);
    if (!(await this.repo.entryExists(patientId, entryId))) {
      throw new NotFoundException(CLINICAL_ENTRY_NOT_FOUND_MESSAGE);
    }

    return this.repo.create({
      patientId,
      clinicalEntryId: entryId,
      reason,
      text,
      authorId: author,
    });
  }
}
