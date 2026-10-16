import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DentitionEventReason, DentitionType } from '@prisma/client';
import {
  DentitionEvent,
  DentitionState,
  PERMANENT_POSITION_PATTERN,
  hasPrimaryPredecessor,
  resolveDentition,
} from '../../domain/dentition';
import { DENTITION_EVENT_REPOSITORY } from '../../domain/ports/dentition-event-repository.port';
import type { DentitionEventRepository } from '../../domain/ports/dentition-event-repository.port';
import { TOOTH_RECORD_REPOSITORY } from '../../domain/ports/tooth-record-repository.port';
import type { ToothRecordRepository } from '../../domain/ports/tooth-record-repository.port';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patients/application/assert-patient-in-clinic';
import {
  ODONTOGRAM_CLOCK,
  resolveClinicDay,
  type OdontogramClock,
} from '../odontogram-clock';

/** Tope de posiciones por petición: la boca entera. */
export const MAX_DENTITION_POSITIONS = 32;

/** Fecha de nacimiento del paciente de ESTA clínica (bajo RLS), o 404. */
export async function patientBirthDate(
  patients: PatientRepository,
  patientId: string,
): Promise<Date | null> {
  const patient = await patients.findById(patientId);
  if (!patient) {
    throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
  }
  return patient.birthDate ?? null;
}

/** Eventos registrados antes del corte (todos si no hay corte). */
export function eventsBefore(
  events: readonly DentitionEvent[],
  cutoff?: Date,
): DentitionEvent[] {
  return cutoff
    ? events.filter((e) => e.recordedAt.getTime() < cutoff.getTime())
    : [...events];
}

export interface DentitionView extends DentitionState {
  /** El `asOf` pedido, o null si es el estado actual. */
  asOf: string | null;
}

@Injectable()
export class GetDentitionUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
    @Inject(DENTITION_EVENT_REPOSITORY)
    private readonly events: DentitionEventRepository,
    @Inject(TOOTH_RECORD_REPOSITORY)
    private readonly records: ToothRecordRepository,
    @Inject(ODONTOGRAM_CLOCK)
    private readonly now: OdontogramClock,
  ) {}

  /**
   * Dentición de cada posición (DX-120): el último evento o, sin eventos, la
   * edad (< 6 temporal, 6-12 según la tabla de erupción, > 12 permanente).
   * No escribe nada. Con `asOf`, la de ese día (edad y eventos de entonces).
   */
  async execute(patientId: string, asOf?: string): Promise<DentitionView> {
    const birthDate = await patientBirthDate(this.patients, patientId);
    const day = resolveClinicDay(
      asOf,
      this.now(),
      await this.records.clinicTimeZone(),
    );
    const events = eventsBefore(
      await this.events.listByPatient(patientId),
      day.cutoff,
    );
    return {
      ...resolveDentition({ birthDate, onDate: day.onDate, events }),
      asOf: asOf ?? null,
    };
  }
}

export interface RecordDentitionEventsInput {
  positions: string[];
  dentition: DentitionType;
  reason: DentitionEventReason;
}

@Injectable()
export class RecordDentitionEventsUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
    @Inject(DENTITION_EVENT_REPOSITORY)
    private readonly events: DentitionEventRepository,
  ) {}

  /**
   * Cambia la dentición de una o varias posiciones (un evento por posición,
   * todos en una transacción). Las reglas de la BD (CHECK) se comprueban
   * antes aquí para responder 422 en español en vez de un error genérico.
   */
  async execute(
    patientId: string,
    input: RecordDentitionEventsInput,
    performedById: string,
  ): Promise<DentitionEvent[]> {
    const { positions, dentition, reason } = input;
    if (
      positions.length === 0 ||
      positions.length > MAX_DENTITION_POSITIONS ||
      new Set(positions).size !== positions.length ||
      !positions.every((p) => PERMANENT_POSITION_PATTERN.test(p))
    ) {
      throw new BadRequestException(
        'Indica de 1 a 32 posiciones distintas con su código FDI permanente (11-18, 21-28, 31-38, 41-48)',
      );
    }
    const molars = positions.filter((p) => !hasPrimaryPredecessor(p));
    if (dentition === DentitionType.MIXED && molars.length > 0) {
      throw new UnprocessableEntityException(
        `La posición ${molars.join(', ')} no tiene diente temporal: no puede estar en dentición mixta`,
      );
    }
    if (reason === DentitionEventReason.EXFOLIATION) {
      if (molars.length > 0) {
        throw new UnprocessableEntityException(
          `La posición ${molars.join(', ')} no tiene diente temporal que exfoliar`,
        );
      }
      if (dentition !== DentitionType.PERMANENT) {
        throw new UnprocessableEntityException(
          'Exfoliar el diente temporal deja la posición en dentición permanente',
        );
      }
    }

    await patientBirthDate(this.patients, patientId);
    return this.events.createMany(
      patientId,
      positions.map((position) => ({ position, dentition, reason })),
      performedById,
    );
  }
}
