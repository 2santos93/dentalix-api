import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { TOOTH_RECORD_REPOSITORY } from '../../domain/ports/tooth-record-repository.port';
import type { ToothRecordRepository } from '../../domain/ports/tooth-record-repository.port';
import { ToothRecord } from '../../domain/entities/tooth-record.entity';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';

export const TOOTH_RECORD_NOT_FOUND_MESSAGE =
  'Registro del odontograma no encontrado';
export const VOID_REASON_MAX = 500;

@Injectable()
export class VoidToothRecordUseCase {
  constructor(
    @Inject(TOOTH_RECORD_REPOSITORY)
    private readonly repo: ToothRecordRepository,
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
  ) {}

  /**
   * Anula un registro del odontograma (DX-120): INSERTA otro registro que lo
   * señala, con motivo, autor (del token) y fecha (de la BD). El original no
   * se toca (la BD lo impide con un trigger); deja de pintarse en la carta y
   * aparece tachado en el historial. Lo anula quien lo registró o un ADMIN;
   * una sola vez (índice único parcial).
   */
  async execute(
    patientId: string,
    recordId: string,
    reason: string,
    actor: { userId: string; role: ClinicRole },
  ): Promise<ToothRecord> {
    const trimmed = reason.trim();
    if (trimmed === '') {
      throw new BadRequestException('El motivo de la anulación es obligatorio');
    }
    if (trimmed.length > VOID_REASON_MAX) {
      throw new BadRequestException(
        `El motivo admite como mucho ${VOID_REASON_MAX} caracteres`,
      );
    }
    await assertPatientInClinic(this.patients, patientId);
    const target = await this.repo.findById(patientId, recordId);
    if (!target) {
      throw new NotFoundException(TOOTH_RECORD_NOT_FOUND_MESSAGE);
    }
    if (target.voidsRecordId !== null) {
      throw new UnprocessableEntityException(
        'Una anulación no se puede anular',
      );
    }
    if (
      actor.role !== ClinicRole.ADMIN &&
      target.performedById !== actor.userId
    ) {
      throw new ForbiddenException(
        'Solo quien hizo el registro o un administrador puede anularlo',
      );
    }
    const outcome = await this.repo.createVoid({
      patientId,
      target,
      reason: trimmed,
      performedById: actor.userId,
    });
    if (outcome.kind === 'ALREADY_VOIDED') {
      throw new ConflictException('Este registro ya está anulado');
    }
    return outcome.record;
  }
}
