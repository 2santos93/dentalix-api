import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DocumentType, TriageFlag } from '@prisma/client';
import { APPOINTMENT_REPOSITORY } from '../../domain/ports/appointment-repository.port';
import type { AppointmentRepository } from '../../domain/ports/appointment-repository.port';
import { WALK_IN_REPOSITORY } from '../../domain/ports/walk-in-repository.port';
import type {
  WalkInPatient,
  WalkInReplay,
  WalkInRepository,
} from '../../domain/ports/walk-in-repository.port';
import type { AppointmentWriteResult } from '../../domain/entities/appointment.entity';
import {
  IDEMPOTENCY_KEY_REUSED_CODE,
  NO_RESERVED_SLOT_CODE,
  PATIENT_DUPLICATE_CODE,
  WALK_IN_MESSAGES,
  findReservedSlot,
  floorToMinute,
  normalizeTriageFlags,
  normalizeTriageNote,
  overbookReasonError,
  triageNoteError,
  walkInRequestFingerprint,
  type Interval,
} from '../../domain/walk-in';
import { parseIdempotencyKey } from '../../../expenses/domain/expense-idempotency';
import { checkScheduleBlocks } from '../schedule-block-check';
import { NO_WARNINGS, collectWarnings } from '../appointment-warnings';
import {
  OVERLAP_MESSAGES,
  overlapExclusionScope,
} from '../appointment-overlap-error';
import {
  SCHEDULE_BLOCK_CLOCK,
  systemScheduleBlockClock,
  type ScheduleBlockClock,
} from '../../../schedule-blocks/application/schedule-block-clock';
import { SCHEDULE_BLOCK_REPOSITORY } from '../../../schedule-blocks/domain/ports/schedule-block-repository.port';
import type { ScheduleBlockRepository } from '../../../schedule-blocks/domain/ports/schedule-block-repository.port';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { docTypeLabelInput } from '../../../patients/application/doc-type-label-input';
import { DOC_TAKEN_MESSAGE } from '../../../patients/infrastructure/repositories/prisma-patient.repository';
import { STAFF_REPOSITORY } from '../../../staff/domain/ports/staff-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import { assertAttendsAt } from '../../../staff/domain/provider-location';
import { APPOINTMENT_TYPE_REPOSITORY } from '../../../appointment-types/domain/ports/appointment-type-repository.port';
import type { AppointmentTypeRepository } from '../../../appointment-types/domain/ports/appointment-type-repository.port';
import type { AppointmentType } from '../../../appointment-types/domain/entities/appointment-type.entity';
import { endFromDuration } from '../../../appointment-types/domain/appointment-type-rules';
import { LOCATION_REPOSITORY } from '../../../locations/domain/ports/location-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import { requireLocationTimeZone } from '../../../../shared/locations/location-time-zone';
import { civilDateIn, civilDayRange } from '../../../../shared/time/civil-day';
import { ProviderAvailabilityService } from '../../../provider-schedule/application/provider-availability.service';
import { PROVIDER_OFF_SCHEDULE } from '../../../provider-schedule/application/provider-availability.service';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

export interface WalkInNewPatientInput {
  firstName: string;
  lastName: string;
  phone: string;
  docType?: DocumentType;
  docTypeLabel?: string | null;
  docNumber?: string;
}

/**
 * Lo que manda el mostrador. Sin sede, hora ni autor: la sede sale del
 * request (cabecera ya validada contra las sedes permitidas, o la sede de
 * escritura de la sesión), la hora del reloj del servidor y el autor del
 * token (`ctx`).
 */
export interface CreateWalkInInput {
  patientId?: string;
  newPatient?: WalkInNewPatientInput;
  providerId: string;
  /** Tipo urgente concreto; sin él, el primer tipo urgente activo. */
  appointmentTypeId?: string;
  triageFlags?: TriageFlag[];
  triageNote?: string | null;
  /** Sobrecupo AHORA con su motivo (5–300); sin él, hueco reservado o 409. */
  overbookReason?: string;
}

export interface WalkInResult extends AppointmentWriteResult {
  patientCreated: boolean;
  /** Fila con el motivo del sobrecupo (`appointment_reserved_overrides`). */
  overbookId: string | null;
}

/**
 * «Atender sin cita» (DX-470): paciente (existente o alta mínima) y cita de
 * tipo urgente DESDE AHORA, ya en «En clínica», en un paso. La cita va al
 * primer hueco RESERVED libre de hoy del profesional que admite el tipo
 * urgente (DX-446) o, si no hay o el mostrador lo pide con motivo, en
 * sobrecupo anotado. Mismas pertenencias que agendar (paciente, profesional,
 * tipo y sede de ESTA clínica; el profesional atiende en la sede) y los
 * mismos bloqueos (un bloqueo que no deja agendar es 409).
 */
@Injectable()
export class CreateWalkInUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly appointments: AppointmentRepository,
    @Inject(WALK_IN_REPOSITORY)
    private readonly walkIns: WalkInRepository,
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
    @Inject(STAFF_REPOSITORY)
    private readonly staff: StaffRepository,
    @Inject(APPOINTMENT_TYPE_REPOSITORY)
    private readonly types: AppointmentTypeRepository,
    @Inject(SCHEDULE_BLOCK_REPOSITORY)
    private readonly blocks: ScheduleBlockRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    private readonly availability: ProviderAvailabilityService,
    @Optional()
    @Inject(SCHEDULE_BLOCK_CLOCK)
    private readonly clock: ScheduleBlockClock = systemScheduleBlockClock,
  ) {}

  /**
   * DX-510: con `Idempotency-Key` (UUID), repetir la MISMA petición (doble
   * clic, reintento de red) devuelve la cita que creó la primera, sin un
   * segundo paciente ni una segunda cita; con otros datos es un 422
   * `IDEMPOTENCY_KEY_REUSED`. La clave es por clínica y vive con la cita
   * (sin caducidad, como en abonos y gastos). Sin clave, como siempre.
   */
  async execute(
    input: CreateWalkInInput,
    ctx: AuditRequestContext,
    idempotencyHeader?: string,
  ): Promise<WalkInResult> {
    const key = parseIdempotencyKey(idempotencyHeader);
    if (key === null) {
      throw new BadRequestException(WALK_IN_MESSAGES.idempotencyKeyInvalid);
    }
    if (key === undefined) return this.attend(input, ctx, undefined);
    const locationId = await this.appointments.resolveWriteLocationId();
    const fingerprint = walkInRequestFingerprint({ ...input, locationId });
    const stored = await this.walkIns.findByIdempotencyKey(key);
    if (stored) return replayResult(stored, fingerprint);
    try {
      return await this.attend(input, ctx, { key, fingerprint });
    } catch (error) {
      // La otra petición con la misma clave ganó la carrera y su cita ya está
      // escrita: lo que esta vio después (el documento ya dado de alta, el
      // hueco ocupado, el paciente ya en una cita) es esa misma cita.
      const raced = await this.walkIns.findByIdempotencyKey(key);
      if (raced) return replayResult(raced, fingerprint);
      throw error;
    }
  }

  private async attend(
    input: CreateWalkInInput,
    ctx: AuditRequestContext,
    idempotency: { key: string; fingerprint: string } | undefined,
  ): Promise<WalkInResult> {
    const patient = this.patientChoice(input);
    const noteError = triageNoteError(input.triageNote);
    if (noteError !== null) throw new BadRequestException(noteError);
    const overbookReason =
      input.overbookReason === undefined ? null : input.overbookReason.trim();
    if (input.overbookReason !== undefined) {
      const error = overbookReasonError(input.overbookReason);
      if (error !== null) throw new BadRequestException(error);
    }

    if (patient.kind === 'existing') {
      if (!(await this.patients.findById(patient.id))) {
        throw new NotFoundException('Paciente no encontrado');
      }
    } else if (patient.data.docNumber !== undefined) {
      // El duplicado ANTES que el hueco: si no, el mostrador escribiría el
      // motivo del sobrecupo para luego enterarse de que ya era paciente.
      const existingId = await this.walkIns.findLivePatientIdByDoc(
        patient.data.docNumber,
      );
      if (existingId !== null) throw await this.duplicate(existingId);
    }
    const provider = await this.staff.findById(input.providerId);
    if (!provider) throw new NotFoundException('Profesional no encontrado');
    const type = await this.urgentType(input.appointmentTypeId);
    // DX-089: la sede del request o la de escritura de la sesión (ambas ya
    // dentro de las permitidas); el profesional tiene que atender en ella.
    const locationId = await this.appointments.resolveWriteLocationId();
    assertAttendsAt(provider, locationId);
    const location = await this.locations.findById(locationId);
    if (!location) throw new NotFoundException('Sede no encontrada');
    const timeZone = requireLocationTimeZone(location);

    const arrivedAt = this.clock();
    const now = floorToMinute(arrivedAt);
    const today = civilDayRange(civilDateIn(now, timeZone), timeZone);

    let slot: Interval;
    if (overbookReason !== null) {
      slot = { start: now, end: endFromDuration(now, type.durationMinutes) };
    } else {
      const found = await this.findSlot(
        input.providerId,
        patient,
        locationId,
        type,
        now,
        today.end,
      );
      if (found === null) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: NO_RESERVED_SLOT_CODE,
          message: WALK_IN_MESSAGES.noReservedSlot,
          canOverbook: true,
        });
      }
      slot = found;
    }

    // Los bloqueos que no dejan agendar (vacaciones, reunión) mandan también
    // aquí; un reservado para otros tipos sin liberar, el 409 de DX-446.
    const blockCheck = await checkScheduleBlocks(
      this.blocks,
      {
        providerId: input.providerId,
        start: slot.start,
        end: slot.end,
        locationId,
      },
      {
        appointmentTypeId: type.id,
        now: arrivedAt,
        actorRole: ctx.actor.role,
      },
    );
    // El paciente ya está aquí: fuera del horario del profesional es un aviso,
    // también en el modo estricto de la clínica.
    const offSchedule = await this.availability.offScheduleMessage({
      providerId: input.providerId,
      locationId,
      start: slot.start,
      end: slot.end,
    });
    const warnings = collectWarnings(
      blockCheck.warnings,
      offSchedule === null
        ? null
        : { code: PROVIDER_OFF_SCHEDULE, message: offSchedule },
    );

    if (patient.kind === 'existing') {
      const clash = await this.appointments.findOverlappingForPatient(
        patient.id,
        slot.start,
        slot.end,
      );
      if (clash.length > 0) {
        throw new ConflictException(OVERLAP_MESSAGES.patient);
      }
    }

    try {
      const written = await this.walkIns.create(
        {
          patient,
          providerId: input.providerId,
          locationId,
          appointmentTypeId: type.id,
          start: slot.start,
          end: slot.end,
          arrivedAt,
          triageFlags: normalizeTriageFlags(input.triageFlags),
          triageNote: normalizeTriageNote(input.triageNote),
          overbookReason,
          createdById: ctx.actor.userId,
          ...(idempotency ? { idempotency } : {}),
        },
        ctx,
      );
      if (written.replayed) {
        return replayResult(written, idempotency?.fingerprint ?? null);
      }
      return {
        ...written.appointment,
        ...warnings,
        planItemsReservedElsewhere: [],
        patientCreated: written.patientCreated,
        overbookId: written.overbookId,
      };
    } catch (error) {
      // Carrera: otra alta del mismo documento entre la consulta previa y la
      // transacción. El 409 lleva igualmente al existente.
      const racedId = duplicateWithoutPatient(error);
      if (racedId !== null) throw await this.duplicate(racedId);
      const scope = overlapExclusionScope(error);
      if (scope === 'provider') {
        throw new ConflictException(WALK_IN_MESSAGES.slotTaken);
      }
      // Una cita sin cita previa no lleva sillón (DX-211): solo queda el paciente.
      if (scope === 'patient') {
        throw new ConflictException(OVERLAP_MESSAGES.patient);
      }
      throw error;
    }
  }

  /**
   * 409 `PATIENT_DUPLICATE` con el id y el nombre del paciente existente,
   * para que el mostrador vea a quién va a atender. Quien llega aquí tiene un
   * rol de WALK_IN_ROLES, todos dentro de PATIENT_ROLES (leen cualquier
   * paciente de su clínica), y `findById` solo ve la clínica del contexto.
   */
  private async duplicate(existingId: string): Promise<ConflictException> {
    const existing = await this.patients.findById(existingId);
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: PATIENT_DUPLICATE_CODE,
      message: DOC_TAKEN_MESSAGE,
      existingPatientId: existingId,
      ...(existing
        ? {
            existingPatient: {
              id: existing.id,
              firstName: existing.firstName,
              lastName: existing.lastName,
            },
          }
        : {}),
    });
  }

  /** Exactamente uno: el paciente existente o el alta mínima. */
  private patientChoice(input: CreateWalkInInput): WalkInPatient {
    const hasId = input.patientId !== undefined;
    const hasNew = input.newPatient !== undefined;
    if (hasId === hasNew) {
      throw new BadRequestException(WALK_IN_MESSAGES.patientChoice);
    }
    if (input.patientId !== undefined) {
      return { kind: 'existing', id: input.patientId };
    }
    const data = input.newPatient!;
    const docNumber = data.docNumber?.trim() || undefined;
    const firstName = data.firstName.trim();
    const lastName = data.lastName.trim();
    const phone = data.phone.trim();
    // El DTO mide antes de recortar: «   » pasaría y dejaría un paciente sin
    // nombre ni teléfono.
    if (firstName === '' || lastName === '' || phone.length < 5) {
      throw new BadRequestException(WALK_IN_MESSAGES.newPatientBlank);
    }
    return {
      kind: 'new',
      data: {
        firstName,
        lastName,
        phone,
        docType: data.docType ?? DocumentType.OTHER,
        docTypeLabel: docTypeLabelInput(data.docTypeLabel) ?? null,
        docNumber,
      },
    };
  }

  /** El tipo pedido (urgente y activo) o el primer urgente activo por nombre. */
  private async urgentType(id: string | undefined): Promise<AppointmentType> {
    if (id !== undefined) {
      const type = await this.types.findById(id);
      if (!type || !type.active || !type.isUrgent) {
        throw new BadRequestException(WALK_IN_MESSAGES.notUrgentType);
      }
      return type;
    }
    const urgent = (await this.types.list({ includeInactive: false }))
      .filter((t) => t.active && t.isUrgent)
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    if (urgent.length === 0) {
      throw new ConflictException(WALK_IN_MESSAGES.noUrgentType);
    }
    return urgent[0];
  }

  /**
   * Primer hueco reservado libre de hoy, desde ahora: lo ocupado son las
   * citas vivas del profesional (en cualquier sede de la clínica, como la
   * EXCLUDE) y, si el paciente ya existe, las suyas.
   */
  private async findSlot(
    providerId: string,
    patient: WalkInPatient,
    locationId: string,
    type: AppointmentType,
    now: Date,
    until: Date,
  ): Promise<Interval | null> {
    const blocks = await this.blocks.list({
      from: now,
      to: until,
      locationId,
      providerIds: [providerId],
    });
    const busy: Interval[] = await this.appointments.findOverlapping(
      providerId,
      now,
      until,
    );
    if (patient.kind === 'existing') {
      busy.push(
        ...(await this.appointments.findOverlappingForPatient(
          patient.id,
          now,
          until,
        )),
      );
    }
    return findReservedSlot({
      now,
      until,
      durationMinutes: type.durationMinutes,
      appointmentTypeId: type.id,
      blocks: blocks.filter(
        (b) => b.providerId === null || b.providerId === providerId,
      ),
      busy,
    });
  }
}

/**
 * DX-510: la cita que creó la clave, si la petición es la misma; si no, 422.
 * Esta petición no escribió nada: sin avisos ni paciente nuevo.
 */
function replayResult(
  stored: WalkInReplay,
  fingerprint: string | null,
): WalkInResult {
  if (stored.fingerprint !== fingerprint) {
    throw new UnprocessableEntityException({
      statusCode: 422,
      error: 'Unprocessable Entity',
      code: IDEMPOTENCY_KEY_REUSED_CODE,
      message: WALK_IN_MESSAGES.idempotencyKeyReused,
    });
  }
  return {
    ...stored.appointment,
    ...NO_WARNINGS,
    planItemsReservedElsewhere: [],
    patientCreated: false,
    overbookId: stored.overbookId,
  };
}

/** El id del 409 `PATIENT_DUPLICATE` de la transacción (que no trae nombre). */
function duplicateWithoutPatient(error: unknown): string | null {
  if (!(error instanceof ConflictException)) return null;
  const body = error.getResponse() as Record<string, unknown>;
  return body.code === PATIENT_DUPLICATE_CODE &&
    typeof body.existingPatientId === 'string' &&
    body.existingPatient === undefined
    ? body.existingPatientId
    : null;
}
