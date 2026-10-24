import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CLINICAL_ENTRY_REPOSITORY } from '../../domain/ports/clinical-entry-repository.port';
import type {
  ClinicalEntryAppointmentRef,
  ClinicalEntryRepository,
} from '../../domain/ports/clinical-entry-repository.port';
import { ClinicalEntry } from '../../domain/entities/clinical-entry.entity';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';
import { assertAuthor } from '../clinical-record-errors';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { CLINICAL_NOTE_TEMPLATE_REPOSITORY } from '../../../clinical-note-templates/domain/ports/clinical-note-template-repository.port';
import type { ClinicalNoteTemplateRepository } from '../../../clinical-note-templates/domain/ports/clinical-note-template-repository.port';
import type { ClinicalNoteTemplate } from '../../../clinical-note-templates/domain/entities/clinical-note-template.entity';
import {
  answerText,
  composeNote,
  type NoteAnswer,
} from '../../../clinical-note-templates/domain/note-template-rules';
import {
  validateDiagnoses,
  type DiagnosisInput,
  type ValidDiagnosis,
} from '../../domain/diagnosis-rules';
import { ICD10_INVALID_MESSAGE } from '../../../../shared/validation/health-codes';
import {
  INACTIVE_NOTE_TEMPLATE_MESSAGE,
  NOTE_TEMPLATE_NOT_FOUND_MESSAGE,
} from '../../../clinical-note-templates/application/note-template-errors';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

export const ENTRY_APPOINTMENT_NOT_FOUND_MESSAGE =
  'Cita no encontrada en esta clínica';
export const ENTRY_APPOINTMENT_OTHER_PATIENT_MESSAGE =
  'La cita no es de este paciente: registra la evolución desde la ficha del paciente de la cita';
export const ENTRY_APPOINTMENT_NOT_ATTENDED_MESSAGE =
  'No se puede registrar una evolución en una cita cancelada o en la que el paciente no asistió';
export const ENTRY_APPOINTMENT_FUTURE_MESSAGE =
  'No se puede registrar una evolución en una cita de un día futuro';
export const BLANK_NOTES_MESSAGE =
  'El texto de la evolución no puede estar vacío';

/** DX-170: respuesta a una pregunta de la plantilla. */
export interface ClinicalEntryAnswerInput extends NoteAnswer {
  promptId: string;
}

// NOTE: deliberately NO `tenantId`/`id`/`createdAt`/`performedById` field —
// tenant comes from the guarded request context (never the client, same
// convention as MedicalHistoryVersionData / CreateCatalogItemInput);
// `performedById` is passed as a separate explicit argument sourced from
// `req.user.sub` in the controller, never taken from the request body.
export interface CreateClinicalEntryInput {
  entryDate?: Date;
  reason?: string;
  /**
   * Texto final. Con plantilla, el texto compuesto que el profesional revisó
   * y quizá editó; si falta, el servidor lo compone con `answers`.
   */
  notes?: string;
  /** DX-170: cita en la que se documenta (de este paciente). */
  appointmentId?: string;
  /** DX-170: plantilla de la clínica, activa. */
  templateId?: string;
  /** DX-170: respuestas a las preguntas de `templateId` (sin `notes`). */
  answers?: ClinicalEntryAnswerInput[];
  /**
   * DX-212: diagnósticos CIE-10 (1 principal y hasta 3 relacionados). Sin
   * ellos la evolución se sigue guardando.
   */
  diagnoses?: DiagnosisInput[];
}

const NOT_ATTENDED = new Set(['CANCELLED', 'NO_SHOW']);

@Injectable()
export class CreateClinicalEntryUseCase {
  constructor(
    @Inject(CLINICAL_ENTRY_REPOSITORY)
    private readonly repo: ClinicalEntryRepository,
    // Resuelve "¿este paciente es de ESTA clínica?" bajo RLS antes de insertar
    // (SEC-004): la FK a patients se chequea saltando la RLS, así que sin esto
    // se podía escribir contra un paciente de otra clínica.
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
    // DX-170: la plantilla tiene que ser de ESTA clínica y estar activa.
    @Inject(CLINICAL_NOTE_TEMPLATE_REPOSITORY)
    private readonly templates: ClinicalNoteTemplateRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Append-only: ALWAYS inserts a brand-new entry via `repo.create` — there
   * is no update/delete method on the port at all, so immutability is
   * enforced at the interface level, not just by convention.
   *
   * DX-170: con plantilla, el texto compuesto queda en `notes` (lo que se
   * guarda es TEXTO: editar o desactivar la plantilla después no lo cambia).
   * Con cita, la evolución queda ligada a ella y, si no trae fecha de
   * atención, toma el día de la cita en la zona de su sede.
   */
  async execute(
    patientId: string,
    input: CreateClinicalEntryInput,
    performedById: string,
  ): Promise<ClinicalEntry> {
    // DX-038: autoría obligatoria (la BD además exige performedById NOT NULL).
    const author = assertAuthor(performedById);
    if (input.answers !== undefined && input.templateId === undefined) {
      throw new BadRequestException(
        'Las respuestas necesitan una plantilla (templateId)',
      );
    }
    if (input.answers !== undefined && input.notes !== undefined) {
      throw new BadRequestException(
        'Envía el texto final (notes) o las respuestas (answers), no ambos',
      );
    }
    if (input.templateId === undefined && !input.notes?.trim()) {
      throw new BadRequestException(BLANK_NOTES_MESSAGE);
    }

    await assertPatientInClinic(this.patients, patientId);
    const appointment = input.appointmentId
      ? await this.appointmentFor(patientId, input.appointmentId)
      : null;
    const notes = input.templateId
      ? await this.templateNotes(input.templateId, input)
      : (input.notes as string);
    if (notes.trim() === '') throw new BadRequestException(BLANK_NOTES_MESSAGE);
    const diagnoses = await this.diagnosesFor(input.diagnoses);

    // Rebuild the payload from only the known fields — same defensive
    // convention as SaveMedicalHistoryUseCase / CreateCatalogItemUseCase:
    // anything sneaked into `input` beyond this shape (e.g. a client-supplied
    // `tenantId`/`performedById`) is dropped here, never forwarded to the
    // repository.
    return this.repo.create({
      patientId,
      // Fecha de atención: la indicada, el día de la cita o "ahora".
      entryDate:
        input.entryDate ??
        (appointment ? appointmentDay(appointment) : new Date()),
      reason: input.reason,
      notes,
      performedById: author,
      appointmentId: appointment?.id,
      templateId: input.templateId,
      diagnoses,
    });
  }

  /**
   * DX-212: forma (1 principal, ≤ 3 relacionados, códigos y dientes) y que
   * cada código exista en la tabla CIE-10. Cualquier fallo es un 400 y no se
   * guarda nada: los diagnósticos van en la misma transacción que la evolución.
   */
  private async diagnosesFor(
    input: DiagnosisInput[] | undefined,
  ): Promise<ValidDiagnosis[]> {
    const result = validateDiagnoses(input);
    if ('error' in result) throw new BadRequestException(result.error);
    if (result.diagnoses.length === 0) return [];
    const codes = result.diagnoses.map((d) => d.icd10Code);
    const existing = await this.repo.existingIcd10Codes(codes);
    const unknown = codes.find((code) => !existing.has(code));
    if (unknown) {
      throw new BadRequestException(`${ICD10_INVALID_MESSAGE}: «${unknown}»`);
    }
    return result.diagnoses;
  }

  /**
   * Cita viva de la clínica, de ESTE paciente, no cancelada ni no-show y no de
   * un día futuro en la zona de su sede: una evolución documenta una atención
   * y su fecha (la de la cita) no puede ser de mañana (DX-039 la usa para la
   * retención).
   */
  private async appointmentFor(
    patientId: string,
    appointmentId: string,
  ): Promise<ClinicalEntryAppointmentRef> {
    const appointment = await this.repo.findAppointment(appointmentId);
    if (!appointment) {
      throw new NotFoundException(ENTRY_APPOINTMENT_NOT_FOUND_MESSAGE);
    }
    // SEC-045 (DX-089): la evolución toma la sede de la cita; un miembro
    // acotado no la escribe en una sede que no tiene (403).
    this.tenantContext.assertLocationAllowed(appointment.locationId);
    if (appointment.patientId !== patientId) {
      throw new BadRequestException(ENTRY_APPOINTMENT_OTHER_PATIENT_MESSAGE);
    }
    if (NOT_ATTENDED.has(appointment.status)) {
      throw new BadRequestException(ENTRY_APPOINTMENT_NOT_ATTENDED_MESSAGE);
    }
    const { start, timeZone } = appointment;
    if (civilDateIn(start, timeZone) > civilDateIn(new Date(), timeZone)) {
      throw new BadRequestException(ENTRY_APPOINTMENT_FUTURE_MESSAGE);
    }
    return appointment;
  }

  /** El texto final, o el que componen las respuestas con la plantilla. */
  private async templateNotes(
    templateId: string,
    input: CreateClinicalEntryInput,
  ): Promise<string> {
    const template = await this.templates.findById(templateId);
    if (!template) throw new NotFoundException(NOTE_TEMPLATE_NOT_FOUND_MESSAGE);
    if (!template.active) {
      throw new BadRequestException(INACTIVE_NOTE_TEMPLATE_MESSAGE);
    }
    if (input.notes !== undefined) return input.notes;
    return compose(template, input.answers ?? []);
  }
}

/**
 * Día de la cita en la zona de su sede, como fecha civil (medianoche UTC): la
 * misma convención que la fecha de atención elegida a mano en la web, que la
 * ficha lee en UTC. Su instante (`start`) daría el día siguiente en una cita de
 * la tarde-noche de Bogotá.
 */
function appointmentDay(appointment: ClinicalEntryAppointmentRef): Date {
  return new Date(
    `${civilDateIn(appointment.start, appointment.timeZone)}T00:00:00.000Z`,
  );
}

function compose(
  template: ClinicalNoteTemplate,
  answers: ClinicalEntryAnswerInput[],
): string {
  const byPrompt = new Map<string, NoteAnswer>();
  for (const answer of answers) {
    if (!template.prompts.some((p) => p.id === answer.promptId)) {
      throw new BadRequestException(
        `La pregunta ${answer.promptId} no es de la plantilla «${template.name}»`,
      );
    }
    byPrompt.set(answer.promptId, answer);
  }
  const filled = template.prompts.map((prompt) => {
    const result = answerText(prompt, byPrompt.get(prompt.id));
    if ('error' in result) throw new BadRequestException(result.error);
    return { label: prompt.label, text: result.text };
  });
  return composeNote(template.body, filled);
}
