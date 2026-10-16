import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  PerioExamDetail,
  PerioExamRecord,
  PerioExamSummary,
  PerioSiteMeasure,
  PerioToothMeasure,
} from '../../domain/entities/perio-exam.entity';
import {
  calMm,
  computePerioIndices,
  isEmptySite,
  isEmptyTooth,
  validatePerioMeasures,
} from '../../domain/perio-measures';
import {
  PERIO_EXAM_REPOSITORY,
  type PerioExamRepository,
  type PerioWriteResult,
} from '../../domain/ports/perio-exam-repository.port';
import {
  PATIENT_REPOSITORY,
  type PatientRepository,
} from '../../../patients/domain/ports/patient-repository.port';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';
import { DEFAULT_BUSINESS_HOURS_TIMEZONE } from '../../../../shared/locations/default-business-hours';

export type PerioClock = () => Date;
export const PERIO_CLOCK = Symbol('PERIO_CLOCK');

export const PERIO_EXAM_NOT_FOUND_MESSAGE = 'Examen periodontal no encontrado';
export const PERIO_EXAM_FINAL_MESSAGE =
  'El examen está finalizado: no se puede modificar ni borrar. Para corregirlo crea un examen nuevo.';

/** Fecha de calendario (`YYYY-MM-DD`) de `at` en la zona de la clínica. */
function clinicDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_BUSINESS_HOURS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Una celda limpiada queda como fila vacía (no hay borrado duro): el detalle
 * no la devuelve.
 */
function toDetail(record: PerioExamRecord): PerioExamDetail {
  const toothOrder = (a: { toothFdi: number }, b: { toothFdi: number }) =>
    a.toothFdi - b.toothFdi;
  return {
    ...record,
    sites: record.sites
      .filter((s) => !isEmptySite(s))
      .sort(toothOrder)
      .map((s) => ({ ...s, calMm: calMm(s.probingMm, s.recessionMm) })),
    teeth: record.teeth.filter((t) => !isEmptyTooth(t)).sort(toothOrder),
    indices: computePerioIndices(record.sites, record.teeth),
  };
}

function toSummary(record: PerioExamRecord): PerioExamSummary {
  const { sites, teeth, ...header } = record;
  return { ...header, indices: computePerioIndices(sites, teeth) };
}

/** Traduce el resultado de una escritura a 404 / 409. */
function assertWritten(result: PerioWriteResult): void {
  if (result === 'not_found') {
    throw new NotFoundException(PERIO_EXAM_NOT_FOUND_MESSAGE);
  }
  if (result === 'final') {
    throw new ConflictException(PERIO_EXAM_FINAL_MESSAGE);
  }
}

async function loadDetail(
  repo: PerioExamRepository,
  patientId: string,
  id: string,
): Promise<PerioExamDetail> {
  const record = await repo.findById(patientId, id);
  if (!record) {
    throw new NotFoundException(PERIO_EXAM_NOT_FOUND_MESSAGE);
  }
  return toDetail(record);
}

@Injectable()
export class ListPerioExamsUseCase {
  constructor(
    @Inject(PERIO_EXAM_REPOSITORY) private readonly exams: PerioExamRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
  ) {}

  /** Histórico con índices; 404 (no lista vacía) si el paciente es de otra clínica. */
  async execute(patientId: string): Promise<PerioExamSummary[]> {
    await assertPatientInClinic(this.patients, patientId);
    const records = await this.exams.listByPatient(patientId);
    return records.map(toSummary);
  }
}

export interface CreatePerioExamInput {
  /** `YYYY-MM-DD`; por defecto, hoy en la zona de la clínica. */
  examDate?: string;
  notes?: string;
  /** Copia los dientes omitidos del examen más reciente. */
  copySkippedFromLast?: boolean;
}

@Injectable()
export class CreatePerioExamUseCase {
  constructor(
    @Inject(PERIO_EXAM_REPOSITORY) private readonly exams: PerioExamRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
    @Inject(PERIO_CLOCK) private readonly now: PerioClock,
  ) {}

  async execute(
    patientId: string,
    input: CreatePerioExamInput,
    providerId: string,
  ): Promise<PerioExamDetail> {
    const today = clinicDate(this.now());
    const examDate = input.examDate ?? today;
    // Comparación de cadenas YYYY-MM-DD = comparación de fechas.
    if (examDate > today) {
      throw new BadRequestException('La fecha del examen no puede ser futura');
    }
    await assertPatientInClinic(this.patients, patientId);
    let skippedTeeth: number[] = [];
    if (input.copySkippedFromLast) {
      const latest = await this.exams.findLatest(patientId);
      skippedTeeth =
        latest?.teeth.filter((t) => t.skipped).map((t) => t.toothFdi) ?? [];
    }
    const notes = input.notes?.trim() ?? '';
    const record = await this.exams.create({
      patientId,
      providerId,
      examDate,
      notes: notes === '' ? null : notes,
      skippedTeeth,
    });
    return toDetail(record);
  }
}

@Injectable()
export class GetPerioExamUseCase {
  constructor(
    @Inject(PERIO_EXAM_REPOSITORY) private readonly exams: PerioExamRepository,
  ) {}

  execute(patientId: string, id: string): Promise<PerioExamDetail> {
    return loadDetail(this.exams, patientId, id);
  }
}

export interface SavePerioMeasuresInput {
  sites: PerioSiteMeasure[];
  teeth: PerioToothMeasure[];
  notes?: string | null;
}

@Injectable()
export class SavePerioMeasuresUseCase {
  constructor(
    @Inject(PERIO_EXAM_REPOSITORY) private readonly exams: PerioExamRepository,
  ) {}

  /**
   * Upsert masivo de medidas de un DRAFT. Solo toca los sitios/dientes que
   * vienen; uno vacío limpia lo que hubiera. FINAL → 409.
   */
  async execute(
    patientId: string,
    id: string,
    input: SavePerioMeasuresInput,
  ): Promise<PerioExamDetail> {
    const errors = validatePerioMeasures(input);
    if (errors.length > 0) {
      throw new BadRequestException(errors.join('. '));
    }
    let notes: string | null | undefined;
    if (input.notes !== undefined) {
      const trimmed = input.notes?.trim() ?? '';
      notes = trimmed === '' ? null : trimmed;
    }
    assertWritten(
      await this.exams.saveMeasures(patientId, id, {
        sites: input.sites,
        teeth: input.teeth,
        notes,
      }),
    );
    return loadDetail(this.exams, patientId, id);
  }
}

@Injectable()
export class FinalizePerioExamUseCase {
  constructor(
    @Inject(PERIO_EXAM_REPOSITORY) private readonly exams: PerioExamRepository,
    @Inject(PERIO_CLOCK) private readonly now: PerioClock,
  ) {}

  /** DRAFT → FINAL. A partir de aquí el examen es inmutable. */
  async execute(patientId: string, id: string): Promise<PerioExamDetail> {
    assertWritten(await this.exams.finalize(patientId, id, this.now()));
    return loadDetail(this.exams, patientId, id);
  }
}

@Injectable()
export class DeletePerioExamUseCase {
  constructor(
    @Inject(PERIO_EXAM_REPOSITORY) private readonly exams: PerioExamRepository,
  ) {}

  /** Solo un DRAFT se borra (un FINAL es historia clínica). */
  async execute(patientId: string, id: string): Promise<void> {
    assertWritten(await this.exams.deleteDraft(patientId, id));
  }
}
