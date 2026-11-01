import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  RecallContactChannel,
  RecallContactOutcome,
  RecallKind,
} from '@prisma/client';
import {
  phoneRegionOrNull,
  whatsAppDigits,
} from '../../../../shared/phone/phone-number';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { parseCivilDate } from '../../../../shared/time/civil-day';
import {
  RECALL_REPOSITORY,
  type RecallRepository,
} from '../../domain/ports/recall-repository.port';
import {
  RECALL_DEFAULT_PAGE_SIZE,
  RECALL_DISABLED_REASON_MAX,
  RECALL_MAX_PAGE_SIZE,
  RECALL_NOTE_MAX,
  type PatientRecalls,
  type RecallContactView,
  type RecallDuePage,
  type RecallDueSort,
} from '../../domain/recall.entity';
import {
  RECALL_INTERVAL_MAX,
  RECALL_INTERVAL_MIN,
  RECALL_WITHIN_DAYS_MAX,
  recallState,
} from '../../domain/recall-rules';

export type RecallClock = () => Date;
export const RECALL_CLOCK = Symbol('RECALL_CLOCK');

export const PATIENT_NOT_FOUND_MESSAGE = 'Paciente no encontrado.';
export const RECALL_NOT_FOUND_MESSAGE = 'Recall no encontrado.';
export const INTERVAL_RANGE_MESSAGE = `El intervalo va de ${RECALL_INTERVAL_MIN} a ${RECALL_INTERVAL_MAX} meses.`;
export const LAST_DONE_INVALID_MESSAGE =
  'La fecha del último control debe ser una fecha válida (AAAA-MM-DD).';
export const LAST_DONE_FUTURE_MESSAGE =
  'La fecha del último control no puede ser posterior a hoy.';
export const DISABLED_UNTIL_INVALID_MESSAGE =
  'La fecha de reactivación debe ser una fecha válida (AAAA-MM-DD).';
export const DISABLED_UNTIL_PAST_MESSAGE =
  'Para pausar el recall, la fecha de reactivación tiene que ser posterior a hoy.';
export const DISABLED_REASON_TOO_LONG_MESSAGE = `El motivo admite hasta ${RECALL_DISABLED_REASON_MAX} caracteres.`;
export const NOTE_TOO_LONG_MESSAGE = `La nota admite hasta ${RECALL_NOTE_MAX} caracteres.`;
export const BOOKED_NEEDS_APPOINTMENT_MESSAGE =
  '«Agendó» necesita la cita que se creó.';
export const APPOINTMENT_NOT_OF_PATIENT_MESSAGE =
  'La cita no es de este paciente.';

function wholeOrDefault(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export interface ListDueRecallsInput {
  kind?: RecallKind;
  withinDays?: number;
  sort?: RecallDueSort;
  page?: number;
  pageSize?: number;
}

/**
 * Lista de llamada (DX-015): recalls vencidos (o que vencen en ≤ `withinDays`)
 * de pacientes sin cita futura, en la sede activa (o las permitidas), por días
 * de vencido. Paginada con tope de 100 por página.
 */
@Injectable()
export class ListDueRecallsUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
    @Inject(RECALL_CLOCK) private readonly now: RecallClock,
  ) {}

  async execute(input: ListDueRecallsInput): Promise<RecallDuePage> {
    const page = wholeOrDefault(input.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = wholeOrDefault(
      input.pageSize,
      RECALL_DEFAULT_PAGE_SIZE,
      1,
      RECALL_MAX_PAGE_SIZE,
    );
    const { rows, total } = await this.repo.listDue({
      kind: input.kind,
      withinDays: wholeOrDefault(
        input.withinDays,
        0,
        0,
        RECALL_WITHIN_DAYS_MAX,
      ),
      sort: input.sort ?? 'MOST_OVERDUE',
      page,
      pageSize,
      now: this.now(),
    });
    return {
      items: rows.map((row) => ({
        recallId: row.recallId,
        patientId: row.patientId,
        patientName: `${row.patientFirstName} ${row.patientLastName}`.trim(),
        // DX-128: con baja de avisos no se ofrece el contacto (ni el número).
        patientPhone: row.reminderOptedOut ? null : row.patientPhone,
        patientWhatsApp: row.reminderOptedOut
          ? null
          : whatsAppDigits(
              row.patientPhone,
              phoneRegionOrNull(row.phoneRegion),
            ),
        reminderOptedOut: row.reminderOptedOut,
        kind: row.kind,
        intervalMonths: row.intervalMonths,
        baseDate: row.baseDate,
        dueAt: row.dueAt,
        daysOverdue: row.daysOverdue,
        locationId: row.locationId,
        lastContact: row.lastContact,
      })),
      total,
      page,
      pageSize,
    };
  }
}

/** Bloque «Recall» de la ficha: cada recall con su estado y el historial de contactos. */
@Injectable()
export class GetPatientRecallsUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
    @Inject(RECALL_CLOCK) private readonly now: RecallClock,
  ) {}

  async execute(patientId: string): Promise<PatientRecalls> {
    if (!(await this.repo.patientExists(patientId))) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    const { rows, contacts } = await this.repo.patientRecalls(
      patientId,
      this.now(),
    );
    const staff = await this.repo.staff(rows.map((r) => r.updatedById));
    return {
      recalls: rows.map((row) => {
        const state = recallState(
          {
            intervalMonths: row.intervalMonths,
            lastDoneAt: row.lastDoneAt,
            lastCompletedVisit: row.lastCompletedVisit,
            active: row.active,
            disabledUntil: row.disabledUntil,
            hasUpcomingAppointment: row.hasUpcomingAppointment,
            archived: false,
          },
          row.today,
        );
        return {
          id: row.id,
          kind: row.kind,
          intervalMonths: row.intervalMonths,
          lastDoneAt: row.lastDoneAt,
          active: row.active,
          disabledUntil: row.disabledUntil,
          disabledReason: row.disabledReason,
          locationId: row.locationId,
          baseDate: state.baseDate,
          dueAt: state.dueAt,
          daysOverdue: state.daysOverdue,
          status: state.status,
          updatedAt: row.updatedAt,
          updatedBy: staff.get(row.updatedById) ?? {
            id: row.updatedById,
            fullName: null,
          },
        };
      }),
      contacts,
    };
  }
}

export interface SetPatientRecallInput {
  intervalMonths: number;
  /** Día del último control; por defecto, hoy en la sede. */
  lastDoneAt?: string;
  /** `false` retira el recall (no sale en la lista); por defecto `true`. */
  active?: boolean;
  /** Pausa hasta ese día (posterior a hoy); `null` la quita. */
  disabledUntil?: string | null;
  disabledReason?: string | null;
}

/**
 * Fijar el recall de un tipo (DX-015): «control cada 6 meses». Crea o cambia el
 * único recall del paciente de ese tipo. Lo hace el clínico; cada cambio deja
 * un audit_event (en el controlador).
 */
@Injectable()
export class SetPatientRecallUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
    @Inject(RECALL_CLOCK) private readonly now: RecallClock,
    private readonly getRecalls: GetPatientRecallsUseCase,
  ) {}

  async execute(
    patientId: string,
    kind: RecallKind,
    input: SetPatientRecallInput,
    actorId: string,
  ): Promise<PatientRecalls> {
    if (
      !Number.isInteger(input.intervalMonths) ||
      input.intervalMonths < RECALL_INTERVAL_MIN ||
      input.intervalMonths > RECALL_INTERVAL_MAX
    ) {
      throw new BadRequestException(INTERVAL_RANGE_MESSAGE);
    }
    if (!(await this.repo.patientExists(patientId))) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    const today = await this.repo.writeToday(this.now());

    let lastDoneAt = today;
    if (input.lastDoneAt !== undefined) {
      const parsed = parseCivilDate(input.lastDoneAt);
      if (parsed === null || parsed < '1900-01-01') {
        throw new BadRequestException(LAST_DONE_INVALID_MESSAGE);
      }
      if (parsed > today) {
        throw new BadRequestException(LAST_DONE_FUTURE_MESSAGE);
      }
      lastDoneAt = parsed;
    }

    let disabledUntil: string | null = null;
    if (input.disabledUntil) {
      const parsed = parseCivilDate(input.disabledUntil);
      if (parsed === null) {
        throw new BadRequestException(DISABLED_UNTIL_INVALID_MESSAGE);
      }
      if (parsed <= today) {
        throw new BadRequestException(DISABLED_UNTIL_PAST_MESSAGE);
      }
      disabledUntil = parsed;
    }
    const reason = input.disabledReason?.trim() || null;
    if (reason !== null && reason.length > RECALL_DISABLED_REASON_MAX) {
      throw new BadRequestException(DISABLED_REASON_TOO_LONG_MESSAGE);
    }

    await this.repo.upsertRecall({
      patientId,
      kind,
      intervalMonths: input.intervalMonths,
      lastDoneAt,
      active: input.active ?? true,
      disabledUntil,
      disabledReason: disabledUntil ? reason : null,
      actorId,
    });
    return this.getRecalls.execute(patientId);
  }
}

export interface CreateRecallContactInput {
  channel: RecallContactChannel;
  outcome: RecallContactOutcome;
  note?: string | null;
  appointmentId?: string | null;
}

/**
 * Registrar un contacto de recall (DX-015). Append-only (también en la BD).
 * La nota es corta y sin datos clínicos; nunca va a logs ni a la auditoría.
 * NO oculta al paciente ni cuenta intentos: eso es DX-465.
 */
@Injectable()
export class CreateRecallContactUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    recallId: string,
    input: CreateRecallContactInput,
    authorId: string,
  ): Promise<RecallContactView> {
    const note = input.note?.trim() ? input.note.trim() : null;
    if (note !== null && note.length > RECALL_NOTE_MAX) {
      throw new BadRequestException(NOTE_TOO_LONG_MESSAGE);
    }
    const appointmentId = input.appointmentId ?? null;
    if (input.outcome === 'BOOKED' && appointmentId === null) {
      throw new BadRequestException(BOOKED_NEEDS_APPOINTMENT_MESSAGE);
    }
    const recall = await this.repo.findRecall(recallId);
    if (!recall) throw new NotFoundException(RECALL_NOT_FOUND_MESSAGE);
    if (
      appointmentId !== null &&
      !(await this.repo.appointmentOfPatient(appointmentId, recall.patientId))
    ) {
      throw new BadRequestException(APPOINTMENT_NOT_OF_PATIENT_MESSAGE);
    }
    return this.repo.createContact({
      recallId: recall.id,
      patientId: recall.patientId,
      locationId: this.tenantContext.getLocationId() ?? null,
      channel: input.channel,
      outcome: input.outcome,
      note,
      appointmentId,
      authorId,
    });
  }
}
