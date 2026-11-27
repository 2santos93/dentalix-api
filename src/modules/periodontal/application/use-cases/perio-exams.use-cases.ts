import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  PerioComparison,
  PerioExamDetail,
  PerioExamRecord,
  PerioExamSummary,
  PerioSiteMeasure,
  PerioToothMeasure,
} from '../../domain/entities/perio-exam.entity';
import {
  PERIO_LIST_MAX,
  calMm,
  computePerioIndices,
  indicesFromCounts,
  isEmptySite,
  isEmptyTooth,
  isValidCivilDate,
  perioThresholdsCode,
  validatePerioMeasures,
  validatePerioThresholds,
  type PerioThresholds,
} from '../../domain/perio-measures';
import {
  PERIO_COMPARE_MAX,
  PERIO_COMPARE_MIN,
  comparePerioExams,
} from '../../domain/perio-comparison';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  PERIO_EXAM_REPOSITORY,
  type PerioExamRepository,
  type PerioExamSummaryRow,
  type PerioWriteResult,
} from '../../domain/ports/perio-exam-repository.port';
import {
  PATIENT_REPOSITORY,
  type PatientRepository,
} from '../../../patients/domain/ports/patient-repository.port';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';

export type PerioClock = () => Date;
export const PERIO_CLOCK = Symbol('PERIO_CLOCK');

export const PERIO_EXAM_NOT_FOUND_MESSAGE = 'Examen periodontal no encontrado';
export const PERIO_EXAM_FINAL_MESSAGE =
  'El examen está finalizado: no se puede modificar ni borrar. Para corregirlo crea un examen nuevo.';
export const PERIO_COMPARE_MESSAGES = {
  count: `Elige entre ${PERIO_COMPARE_MIN} y ${PERIO_COMPARE_MAX} exámenes para comparar`,
  repeated: 'Un examen está repetido en la comparación',
  notFinal:
    'Solo se comparan exámenes finalizados: finaliza el borrador o quítalo de la comparación',
} as const;

/** Notas recortadas; vacías = sin notas. */
function normalizeNotes(notes: string | null | undefined): string | null {
  const trimmed = notes?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Fecha de calendario (`YYYY-MM-DD`) de `at` en la zona `timeZone`. */
function clinicDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Una celda limpiada queda como fila vacía (no hay borrado duro): el detalle
 * no la devuelve.
 */
function toDetail(
  record: PerioExamRecord,
  thresholds: PerioThresholds,
): PerioExamDetail {
  const toothOrder = (a: { toothFdi: number }, b: { toothFdi: number }) =>
    a.toothFdi - b.toothFdi;
  return {
    ...record,
    sites: record.sites
      .filter((s) => !isEmptySite(s))
      .sort(toothOrder)
      .map((s) => ({ ...s, calMm: calMm(s.probingMm, s.recessionMm) })),
    teeth: record.teeth.filter((t) => !isEmptyTooth(t)).sort(toothOrder),
    indices: computePerioIndices(record.sites, record.teeth, thresholds),
    thresholds: { ...thresholds },
  };
}

function toSummary(row: PerioExamSummaryRow): PerioExamSummary {
  const { counts, ...header } = row;
  return { ...header, indices: indicesFromCounts(counts) };
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
  const [record, thresholds] = await Promise.all([
    repo.findById(patientId, id),
    repo.thresholds(),
  ]);
  if (!record) {
    throw new NotFoundException(PERIO_EXAM_NOT_FOUND_MESSAGE);
  }
  return toDetail(record, thresholds);
}

@Injectable()
export class ListPerioExamsUseCase {
  constructor(
    @Inject(PERIO_EXAM_REPOSITORY) private readonly exams: PerioExamRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
  ) {}

  /**
   * Histórico con índices y sin medidas, como mucho los `PERIO_LIST_MAX` más
   * recientes; 404 (no lista vacía) si el paciente es de otra clínica.
   */
  async execute(patientId: string): Promise<PerioExamSummary[]> {
    await assertPatientInClinic(this.patients, patientId);
    const thresholds = await this.exams.thresholds();
    const rows = await this.exams.listSummaries(
      patientId,
      PERIO_LIST_MAX,
      thresholds,
    );
    return rows.map(toSummary);
  }
}

export interface CreatePerioExamInput {
  /** `YYYY-MM-DD`; por defecto, hoy en la zona de la sede activa. */
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
    if (input.examDate !== undefined && !isValidCivilDate(input.examDate)) {
      throw new BadRequestException(
        'La fecha del examen no existe en el calendario',
      );
    }
    // «Hoy» en la zona de la sede activa (su horario), no la del servidor.
    const today = clinicDate(this.now(), await this.exams.clinicTimeZone());
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
    const record = await this.exams.create({
      patientId,
      providerId,
      examDate,
      notes: normalizeNotes(input.notes),
      skippedTeeth,
    });
    return toDetail(record, await this.exams.thresholds());
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
    assertWritten(
      await this.exams.saveMeasures(patientId, id, {
        sites: input.sites,
        teeth: input.teeth,
        notes:
          input.notes === undefined ? undefined : normalizeNotes(input.notes),
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

@Injectable()
export class UpdatePerioNotesUseCase {
  constructor(
    @Inject(PERIO_EXAM_REPOSITORY) private readonly exams: PerioExamRepository,
  ) {}

  /**
   * DX-066: cambia las notas de un DRAFT (null o vacío las borra). Un FINAL
   * sigue inmutable: 409.
   */
  async execute(
    patientId: string,
    id: string,
    notes: string | null,
  ): Promise<PerioExamDetail> {
    assertWritten(
      await this.exams.updateNotes(patientId, id, normalizeNotes(notes)),
    );
    return loadDetail(this.exams, patientId, id);
  }
}

@Injectable()
export class ComparePerioExamsUseCase {
  constructor(
    @Inject(PERIO_EXAM_REPOSITORY) private readonly exams: PerioExamRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
  ) {}

  /**
   * DX-066: compara de 2 a 4 exámenes FINAL del paciente (400 si son menos,
   * más, repetidos o hay un borrador; 404 si alguno no es del paciente o de
   * esta clínica, o el paciente no lo es).
   */
  async execute(
    patientId: string,
    examIds: readonly string[],
  ): Promise<PerioComparison> {
    if (
      examIds.length < PERIO_COMPARE_MIN ||
      examIds.length > PERIO_COMPARE_MAX
    ) {
      throw new BadRequestException(PERIO_COMPARE_MESSAGES.count);
    }
    if (new Set(examIds).size !== examIds.length) {
      throw new BadRequestException(PERIO_COMPARE_MESSAGES.repeated);
    }
    await assertPatientInClinic(this.patients, patientId);
    const [records, thresholds] = await Promise.all([
      this.exams.findManyByIds(patientId, examIds),
      this.exams.thresholds(),
    ]);
    if (records.length !== examIds.length) {
      throw new NotFoundException(PERIO_EXAM_NOT_FOUND_MESSAGE);
    }
    if (records.some((r) => r.status !== 'FINAL')) {
      throw new BadRequestException(PERIO_COMPARE_MESSAGES.notFinal);
    }
    return comparePerioExams(records, thresholds);
  }
}

@Injectable()
export class GetPerioSettingsUseCase {
  constructor(
    @Inject(PERIO_EXAM_REPOSITORY) private readonly exams: PerioExamRepository,
  ) {}

  execute(): Promise<PerioThresholds> {
    return this.exams.thresholds();
  }
}

@Injectable()
export class UpdatePerioSettingsUseCase {
  constructor(
    @Inject(PERIO_EXAM_REPOSITORY) private readonly exams: PerioExamRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  /**
   * DX-066: umbrales de sondaje de la clínica (solo ADMIN, lo exige la ruta).
   * Un campo ausente conserva el valor actual; el par resultante se valida
   * entero (alerta < severo). Si de verdad cambió, se audita como
   * CLINIC_SETTINGS · PERIO_SETTINGS con los campos y el antes y el después
   * en códigos (`PD_A4_S6`).
   */
  async execute(
    input: { pdAlertMm?: unknown; pdSevereMm?: unknown },
    ctx: AuditRequestContext,
  ): Promise<PerioThresholds> {
    const current = await this.exams.thresholds();
    const next = {
      pdAlertMm: input.pdAlertMm ?? current.pdAlertMm,
      pdSevereMm: input.pdSevereMm ?? current.pdSevereMm,
    };
    const errors = validatePerioThresholds(next);
    if (errors.length > 0) {
      throw new BadRequestException(errors.join('. '));
    }
    const { before, after } = await this.exams.setThresholds(
      next as PerioThresholds,
    );
    const changedFields = [
      ...(before.pdAlertMm !== after.pdAlertMm ? ['pdAlertMm'] : []),
      ...(before.pdSevereMm !== after.pdSevereMm ? ['pdSevereMm'] : []),
    ];
    if (changedFields.length > 0) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: null,
        patient: null,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: {
          reason: 'PERIO_SETTINGS',
          changedFields,
          statusChange: {
            from: perioThresholdsCode(before),
            to: perioThresholdsCode(after),
          },
        },
      });
    }
    return after;
  }
}
