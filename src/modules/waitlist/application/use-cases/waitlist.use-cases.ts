import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  WaitlistPriority,
  WaitlistStatus,
  type AuditAction,
} from '@prisma/client';
import type {
  WaitlistEntry,
  WaitlistPage,
} from '../../domain/entities/waitlist-entry.entity';
import {
  WAITLIST_REPOSITORY,
  type WaitlistRepository,
} from '../../domain/ports/waitlist-repository.port';
import {
  WAITLIST_DEFAULT_DURATION_MINUTES,
  WAITLIST_DEFAULT_PAGE_SIZE,
  WAITLIST_DUPLICATE_MESSAGE,
  WAITLIST_MAX_PAGE_SIZE,
  WAITLIST_NOTE_MAX,
  WAITLIST_NOT_FOUND_MESSAGE,
  WAITLIST_NOT_OPEN_MESSAGE,
  WAITLIST_PREFERRED_WINDOW_MAX,
  dismissReasonError,
  textError,
} from '../../domain/waitlist-rules';
import {
  PATIENT_REPOSITORY,
  type PatientRepository,
} from '../../../patients/domain/ports/patient-repository.port';
import {
  LOCATION_REPOSITORY,
  type LocationRepository,
} from '../../../locations/domain/ports/location-repository.port';
import {
  STAFF_REPOSITORY,
  type StaffRepository,
} from '../../../staff/domain/ports/staff-repository.port';
import {
  APPOINTMENT_TYPE_REPOSITORY,
  type AppointmentTypeRepository,
} from '../../../appointment-types/domain/ports/appointment-type-repository.port';
import { appointmentTypeDurationError } from '../../../appointment-types/domain/appointment-type-rules';
import {
  APPOINTMENT_TYPE_UNAVAILABLE_MESSAGE,
  CreateAppointmentUseCase,
} from '../../../appointments/application/use-cases/create-appointment.use-case';
import type { AppointmentWriteResult } from '../../../appointments/domain/entities/appointment.entity';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

function assertValid(error: string | null): void {
  if (error !== null) throw new BadRequestException(error);
}

/** Un `audit_event` de la lista: nunca lleva el motivo ni las notas. */
function recordEntryEvent(
  audit: RecordAuditEventUseCase,
  ctx: AuditRequestContext,
  entry: Pick<WaitlistEntry, 'id' | 'patientId'>,
  action: AuditAction,
  reason: 'WAITLIST_MANUAL' | 'WAITLIST_DISMISSED' | 'WAITLIST_SCHEDULED',
): Promise<void> {
  return audit.record({
    tenantId: ctx.tenantId,
    locationId: ctx.locationId,
    actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
    action,
    resourceType: 'WAITLIST_ENTRY',
    resourceId: entry.id,
    patient: { kind: 'patient', id: entry.patientId },
    requestId: ctx.requestId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { reason },
  });
}

@Injectable()
export class ListWaitlistUseCase {
  constructor(
    @Inject(WAITLIST_REPOSITORY)
    private readonly repo: WaitlistRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
  ) {}

  async execute(params: {
    status?: WaitlistStatus;
    locationId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<WaitlistPage> {
    if (
      params.locationId &&
      !(await this.locations.findById(params.locationId))
    ) {
      throw new NotFoundException('Sede no encontrada');
    }
    return this.repo.list({
      status: params.status ?? WaitlistStatus.OPEN,
      locationId: params.locationId,
      page: Math.max(1, params.page ?? 1),
      pageSize: Math.min(
        WAITLIST_MAX_PAGE_SIZE,
        Math.max(1, params.pageSize ?? WAITLIST_DEFAULT_PAGE_SIZE),
      ),
    });
  }
}

export interface CreateWaitlistEntryInput {
  patientId: string;
  locationId?: string;
  providerId?: string;
  appointmentTypeId?: string;
  durationMinutes?: number;
  priority?: WaitlistPriority;
  preferredWindow?: string;
  note?: string;
}

@Injectable()
export class CreateWaitlistEntryUseCase {
  constructor(
    @Inject(WAITLIST_REPOSITORY)
    private readonly repo: WaitlistRepository,
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(STAFF_REPOSITORY)
    private readonly staff: StaffRepository,
    @Inject(APPOINTMENT_TYPE_REPOSITORY)
    private readonly types: AppointmentTypeRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  /** Alta manual (p. ej. un paciente que llama pidiendo el primer hueco). */
  async execute(
    input: CreateWaitlistEntryInput,
    ctx: AuditRequestContext,
  ): Promise<WaitlistEntry> {
    assertValid(
      textError(
        input.preferredWindow,
        'La franja preferida',
        WAITLIST_PREFERRED_WINDOW_MAX,
      ),
    );
    assertValid(textError(input.note, 'La nota', WAITLIST_NOTE_MAX));
    if (input.durationMinutes !== undefined) {
      assertValid(appointmentTypeDurationError(input.durationMinutes));
    }

    // Cada id del cliente tiene que ser de ESTA clínica (RLS: uno ajeno no se ve).
    if (!(await this.patients.findById(input.patientId))) {
      throw new NotFoundException('Paciente no encontrado');
    }
    // Ya está en la lista (p. ej. canceló hace poco): no se duplica. Dos altas
    // manuales simultáneas podrían colar dos; el panel las enseña y se
    // descarta una (las automáticas son una por cita).
    if (await this.repo.hasOpenForPatient(input.patientId)) {
      throw new ConflictException(WAITLIST_DUPLICATE_MESSAGE);
    }
    if (
      input.locationId &&
      !(await this.locations.findById(input.locationId))
    ) {
      throw new NotFoundException('Sede no encontrada');
    }
    if (input.providerId && !(await this.staff.findById(input.providerId))) {
      throw new NotFoundException('Profesional no encontrado');
    }
    let typeDuration: number | undefined;
    if (input.appointmentTypeId) {
      const type = await this.types.findById(input.appointmentTypeId);
      if (!type || !type.active) {
        throw new BadRequestException(APPOINTMENT_TYPE_UNAVAILABLE_MESSAGE);
      }
      typeDuration = type.durationMinutes;
    }

    const entry = await this.repo.create({
      locationId: input.locationId,
      patientId: input.patientId,
      providerId: input.providerId ?? null,
      appointmentTypeId: input.appointmentTypeId ?? null,
      durationMinutes:
        input.durationMinutes ??
        typeDuration ??
        WAITLIST_DEFAULT_DURATION_MINUTES,
      priority: input.priority ?? WaitlistPriority.NORMAL,
      preferredWindow: input.preferredWindow?.trim() ?? null,
      note: input.note?.trim() ?? null,
      createdById: ctx.actor.userId,
    });
    await recordEntryEvent(this.audit, ctx, entry, 'CREATE', 'WAITLIST_MANUAL');
    return entry;
  }
}

@Injectable()
export class DismissWaitlistEntryUseCase {
  constructor(
    @Inject(WAITLIST_REPOSITORY)
    private readonly repo: WaitlistRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  /** Sacar al paciente de la lista sin agendarlo, con motivo (obligatorio). */
  async execute(
    id: string,
    reason: string,
    ctx: AuditRequestContext,
  ): Promise<WaitlistEntry> {
    assertValid(dismissReasonError(reason));
    const current = await this.repo.findById(id);
    if (!current) throw new NotFoundException(WAITLIST_NOT_FOUND_MESSAGE);
    if (current.status !== WaitlistStatus.OPEN) {
      throw new ConflictException(WAITLIST_NOT_OPEN_MESSAGE);
    }
    const dismissed = await this.repo.dismiss(
      id,
      reason.trim(),
      ctx.actor.userId,
    );
    // Otra persona lo agendó o descartó entre la lectura y la escritura.
    if (!dismissed) throw new ConflictException(WAITLIST_NOT_OPEN_MESSAGE);
    await recordEntryEvent(
      this.audit,
      ctx,
      dismissed,
      'DELETE',
      'WAITLIST_DISMISSED',
    );
    return dismissed;
  }
}

export interface ScheduleFromWaitlistInput {
  providerId: string;
  start: Date;
  /** Si falta: `start` + la duración de la entrada. */
  end?: Date;
  /** Si falta: el de la entrada, si sigue activo. */
  appointmentTypeId?: string;
  reason?: string;
  notes?: string;
}

@Injectable()
export class ScheduleFromWaitlistUseCase {
  constructor(
    @Inject(WAITLIST_REPOSITORY)
    private readonly repo: WaitlistRepository,
    @Inject(APPOINTMENT_TYPE_REPOSITORY)
    private readonly types: AppointmentTypeRepository,
    private readonly createAppointment: CreateAppointmentUseCase,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  /**
   * «Agendar aquí»: crea la cita del paciente de la entrada, en la sede de la
   * entrada, con TODAS las reglas de una cita nueva (pasado, horario,
   * bloqueos, solapes), y la entrada pasa a SCHEDULED en la misma transacción.
   */
  async execute(
    id: string,
    input: ScheduleFromWaitlistInput,
    ctx: AuditRequestContext,
  ): Promise<AppointmentWriteResult> {
    const entry = await this.repo.findById(id);
    if (!entry) throw new NotFoundException(WAITLIST_NOT_FOUND_MESSAGE);
    if (entry.status !== WaitlistStatus.OPEN) {
      throw new ConflictException(WAITLIST_NOT_OPEN_MESSAGE);
    }

    const appointment = await this.createAppointment.execute({
      patientId: entry.patientId,
      providerId: input.providerId,
      start: input.start,
      end:
        input.end ??
        new Date(input.start.getTime() + entry.durationMinutes * 60_000),
      appointmentTypeId:
        input.appointmentTypeId ?? (await this.inheritedType(entry)),
      reason: input.reason,
      notes: input.notes,
      createdById: ctx.actor.userId,
      locationId: entry.locationId,
      waitlistEntryId: entry.id,
    });
    await recordEntryEvent(
      this.audit,
      ctx,
      entry,
      'UPDATE',
      'WAITLIST_SCHEDULED',
    );
    return appointment;
  }

  /** El tipo de la entrada, solo si sigue activo (si no, la cita va sin tipo). */
  private async inheritedType(
    entry: WaitlistEntry,
  ): Promise<string | undefined> {
    if (!entry.appointmentTypeId) return undefined;
    const type = await this.types.findById(entry.appointmentTypeId);
    return type?.active ? type.id : undefined;
  }
}
