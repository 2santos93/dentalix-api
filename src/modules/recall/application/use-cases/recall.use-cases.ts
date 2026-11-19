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
import { civilDateIn, parseCivilDate } from '../../../../shared/time/civil-day';
import { requireLocationTimeZone } from '../../../../shared/locations/location-time-zone';
import {
  RECALL_REPOSITORY,
  type RecallRepository,
} from '../../domain/ports/recall-repository.port';
import {
  RECALL_DEFAULT_PAGE_SIZE,
  RECALL_DISABLED_REASON_MAX,
  RECALL_MAX_PAGE_SIZE,
  RECALL_NOTE_MAX,
  type LocationRecallSettingsView,
  type PatientRecalls,
  type RecallContactView,
  type RecallRef,
  type RecordedRecallContact,
  type RecallDuePage,
  type RecallDueSort,
  type RecallTypeRef,
  type RecallTypeView,
  type RecallUnconfiguredPage,
  type SetPatientRecallResult,
} from '../../domain/recall.entity';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  RECALL_INTERVAL_MAX,
  RECALL_INTERVAL_MIN,
  RECALL_WITHIN_DAYS_MAX,
  recallState,
} from '../../domain/recall-rules';
import {
  CALLBACK_ON_ONLY_CALL_BACK_MESSAGE,
  CALLBACK_ON_REQUIRED_MESSAGE,
  RECALL_BATCH_MAX,
  callbackOnError,
  cycleView,
  recallSettingsError,
  type RecallSettingsValues,
} from '../../domain/recall-cycle';

export type RecallClock = () => Date;
export const RECALL_CLOCK = Symbol('RECALL_CLOCK');

export const PATIENT_NOT_FOUND_MESSAGE = 'Paciente no encontrado.';
export const RECALL_TYPE_NOT_FOUND_MESSAGE =
  'Ese tipo de recall no existe en esta clínica.';
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
  /** DX-015-bis: solo un tipo de la clínica. */
  recallTypeId?: string;
  withinDays?: number;
  sort?: RecallDueSort;
  page?: number;
  pageSize?: number;
  /** DX-465: también los ocultos tras un intento y los que rechazaron. */
  includeContacted?: boolean;
  /** DX-465: solo los de intentos agotados. */
  exhausted?: boolean;
}

/**
 * Lista de llamada (DX-015): recalls vencidos (o que vencen en ≤ `withinDays`)
 * de pacientes sin cita futura, en la sede activa (o las permitidas), por días
 * de vencido. Paginada con tope de 100 por página.
 *
 * DX-465: por defecto sin los ocultos tras un intento (los días de la sede o
 * «Llamar luego»), los que rechazaron (hasta el vencimiento siguiente) ni los
 * de intentos agotados. Es el mismo caso de uso del recuento y de la cola de
 * «Mi día»: el número baja solo y coincide.
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
      recallTypeId: input.recallTypeId,
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
      includeContacted: input.includeContacted ?? false,
      exhausted: input.exhausted ?? false,
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
        recallTypeId: row.recallTypeId,
        recallTypeName: row.recallTypeName,
        intervalMonths: row.intervalMonths,
        baseDate: row.baseDate,
        dueAt: row.dueAt,
        daysOverdue: row.daysOverdue,
        locationId: row.locationId,
        lastContact: row.lastContact,
        lastAttempt: row.lastContact
          ? {
              at: row.lastContact.createdAt,
              outcome: row.lastContact.outcome,
              channel: row.lastContact.channel,
            }
          : null,
        attempts: row.cycle.attempts,
        maxAttempts: row.cycle.maxAttempts,
        exhausted: row.cycle.exhausted,
        hiddenUntil: row.cycle.hiddenUntil,
        callbackOn: row.cycle.callbackOn,
        phoneReview: row.phoneReview,
      })),
      total,
      page,
      pageSize,
    };
  }
}

export interface ListUnconfiguredRecallsInput {
  /** Solo esa sede; tiene que estar entre las permitidas (403 si no). */
  locationId?: string;
  page?: number;
  pageSize?: number;
}

/**
 * D17 · «Sin recall configurado»: pacientes vivos atendidos en los últimos 24
 * meses (en su sede), sin ningún recall activo de un tipo vivo y sin próxima
 * cita; la última visita más reciente primero. Paginada como la de vencidos.
 */
@Injectable()
export class ListUnconfiguredRecallsUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
    @Inject(RECALL_CLOCK) private readonly now: RecallClock,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    input: ListUnconfiguredRecallsInput,
  ): Promise<RecallUnconfiguredPage> {
    // DX-089: un miembro acotado no lista otra sede por la query.
    if (input.locationId) {
      this.tenantContext.assertLocationAllowed(input.locationId);
    }
    const page = wholeOrDefault(input.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = wholeOrDefault(
      input.pageSize,
      RECALL_DEFAULT_PAGE_SIZE,
      1,
      RECALL_MAX_PAGE_SIZE,
    );
    const { rows, total } = await this.repo.listUnconfigured({
      locationId: input.locationId,
      page,
      pageSize,
      now: this.now(),
    });
    return {
      items: rows.map((row) => ({
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
        lastVisitAt: row.lastVisitAt,
        lastVisitLocationId: row.lastVisitLocationId,
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
    const { rows, contacts, phoneReview } = await this.repo.patientRecalls(
      patientId,
      this.now(),
    );
    const staff = await this.repo.staff(rows.map((r) => r.updatedById));
    return {
      recalls: rows.map((row) => {
        const state = recallState(
          {
            lastDoneAt: row.lastDoneAt,
            dueAt: row.dueAt,
            active: row.active,
            disabledUntil: row.disabledUntil,
            hasUpcomingAppointment: row.hasUpcomingAppointment,
            archived: false,
          },
          row.today,
        );
        const cycle = cycleView(
          {
            attemptCount: row.attemptCount,
            lastAttemptAt: row.lastAttemptAt,
            callbackOn: row.callbackOn,
            skipUntil: row.skipUntil,
            cycleDueAt: row.cycleDueAt,
          },
          {
            dueAt: row.dueAt,
            intervalMonths: row.intervalMonths,
            today: row.today,
            lastAttemptDay: row.lastAttemptDay,
            settings: { hideDays: row.hideDays, maxAttempts: row.maxAttempts },
          },
        );
        return {
          id: row.id,
          kind: row.kind,
          recallTypeId: row.recallTypeId,
          recallTypeName: row.recallTypeName,
          intervalMonths: row.intervalMonths,
          lastDoneAt: row.lastDoneAt,
          manualDoneAt: row.manualDoneAt,
          lastDoneItemId: row.lastDoneItemId,
          source: row.source,
          preBackfillDoneAt: row.preBackfillDoneAt,
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
          attempts: cycle.attempts,
          maxAttempts: cycle.maxAttempts,
          exhausted: cycle.exhausted,
          lastAttemptAt:
            cycle.lastAttemptDay !== null ? row.lastAttemptAt : null,
          hiddenUntil: cycle.hiddenUntil,
          callbackOn: cycle.callbackOn,
        };
      }),
      contacts,
      phoneReview,
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
 *
 * DX-015-bis: el tipo llega por su clave del enum (`HYGIENE`, `CHECKUP`:
 * compatibilidad) o por su id. Lo fijado es `manualDoneAt`; la base es el
 * máximo con el último DONE de un procedimiento disparador del tipo. Un alta
 * o una reactivación de un tipo con grupo desactiva los demás recalls activos
 * del paciente de ese grupo (D9) y los devuelve en `recallUpdates`.
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
    type: { systemKey: RecallKind } | { id: string },
    input: SetPatientRecallInput,
    actorId: string,
    audit?: AuditRequestContext,
  ): Promise<SetPatientRecallResult> {
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
    const recallType: RecallTypeRef | null = await this.repo.findType(type);
    if (!recallType) {
      throw new NotFoundException(RECALL_TYPE_NOT_FOUND_MESSAGE);
    }
    const today = await this.repo.writeToday(this.now());

    // Sin fecha: un recall que ya existe conserva lo fijado (y la base que le
    // da un procedimiento); solo uno nuevo nace con hoy (en el repositorio).
    let lastDoneAt: string | undefined;
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

    const { excluded } = await this.repo.upsertRecall({
      patientId,
      recallType,
      intervalMonths: input.intervalMonths,
      manualDoneAt: lastDoneAt,
      newRecallDoneAt: today,
      active: input.active ?? true,
      disabledUntil,
      disabledReason: disabledUntil ? reason : null,
      actorId,
      audit,
    });
    const recalls: PatientRecalls = await this.getRecalls.execute(patientId);
    return { ...recalls, recallUpdates: excluded };
  }
}

/**
 * D15 · «Programar recall» (salida del paciente, «Sin recall configurado»):
 * crea el recall de un tipo con SU intervalo por defecto y la base en la
 * última cita atendida del paciente (o hoy). Solo crea: 409 si ya tiene uno
 * de ese tipo. También lo usa recepción; elegir otro intervalo, editar o
 * reactivar sigue siendo el PUT clínico. Responde como el PUT: la ficha y lo
 * que desactivó la exclusión.
 */
@Injectable()
export class CreateDefaultRecallUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
    @Inject(RECALL_CLOCK) private readonly now: RecallClock,
    private readonly getRecalls: GetPatientRecallsUseCase,
  ) {}

  async execute(
    patientId: string,
    recallTypeId: string,
    actorId: string,
    audit?: AuditRequestContext,
    /** D15 desde la salida: la cita que se despide da la base y la sede. */
    appointmentId?: string,
  ): Promise<SetPatientRecallResult> {
    if (!(await this.repo.patientExists(patientId))) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    const { excluded } = await this.repo.createDefaultRecall({
      patientId,
      recallTypeId,
      appointmentId,
      now: this.now(),
      actorId,
      audit,
    });
    const recalls: PatientRecalls = await this.getRecalls.execute(patientId);
    return { ...recalls, recallUpdates: excluded };
  }
}

/** DX-015-bis: los tipos de recall de la clínica (ficha, filtro de la lista). */
@Injectable()
export class ListRecallTypesUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
  ) {}

  execute(): Promise<RecallTypeView[]> {
    return this.repo.listTypes();
  }
}

export interface CreateRecallContactInput {
  channel: RecallContactChannel;
  outcome: RecallContactOutcome;
  note?: string | null;
  appointmentId?: string | null;
  /** DX-465: «Llamar luego» con fecha (solo con CALL_BACK). */
  callbackOn?: string | null;
}

/** La nota recortada; 400 si pasa del tope. */
function cleanNote(note: string | null | undefined): string | null {
  const clean = note?.trim() ? note.trim() : null;
  if (clean !== null && clean.length > RECALL_NOTE_MAX) {
    throw new BadRequestException(NOTE_TOO_LONG_MESSAGE);
  }
  return clean;
}

/**
 * DX-465: la fecha de «Llamar luego» contra el «hoy» de la sede del paciente
 * (la del recall, la de la lista). 400 con otro desenlace o fuera de rango;
 * 409 LOCATION_TIMEZONE_REQUIRED si esa sede no tiene zona.
 */
function checkedCallbackOn(
  outcome: RecallContactOutcome,
  callbackOn: string | null | undefined,
  recalls: readonly RecallRef[],
  now: Date,
): string | null {
  if (callbackOn === undefined || callbackOn === null) return null;
  if (outcome !== 'CALL_BACK') {
    throw new BadRequestException(CALLBACK_ON_ONLY_CALL_BACK_MESSAGE);
  }
  for (const recall of recalls) {
    const today = civilDateIn(
      now,
      requireLocationTimeZone({
        id: recall.locationId,
        timeZone: recall.timeZone,
      }),
    );
    const error = callbackOnError(callbackOn, today);
    if (error) throw new BadRequestException(error);
  }
  return callbackOn;
}

/**
 * Registrar un contacto de recall (DX-015). Append-only (también en la BD).
 * La nota es corta y sin datos clínicos; nunca va a logs ni a la auditoría.
 *
 * DX-465: el contacto es el INTENTO y deja el estado del ciclo en la misma
 * transacción (cuenta, oculta N días, «Llamar luego» hasta su fecha, «Rechaza»
 * hasta el vencimiento siguiente, «Agendó» lo cierra; «Número equivocado»
 * marca el teléfono para revisar). Un «Agendó» de una cita que ya lo tiene en
 * este recall (lo escribió el servidor al crearla) devuelve el existente con
 * `replayed` (el controlador responde 200 y no audita otra alta).
 */
@Injectable()
export class CreateRecallContactUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(RECALL_CLOCK) private readonly now: RecallClock,
  ) {}

  async execute(
    recallId: string,
    input: CreateRecallContactInput,
    authorId: string,
  ): Promise<RecordedRecallContact> {
    const note = cleanNote(input.note);
    const appointmentId = input.appointmentId ?? null;
    if (input.outcome === 'BOOKED' && appointmentId === null) {
      throw new BadRequestException(BOOKED_NEEDS_APPOINTMENT_MESSAGE);
    }
    const recall = await this.repo.findRecall(recallId);
    if (!recall) throw new NotFoundException(RECALL_NOT_FOUND_MESSAGE);
    // DX-089: se autoriza por la sede del recall, nunca por la cabecera (otra
    // sede permitida no abre esta). Un recall siempre tiene sede, así que aquí
    // no aplica el «toda la clínica» de la ficha del paciente.
    this.tenantContext.assertLocationAllowed(recall.locationId);
    const callbackOn = checkedCallbackOn(
      input.outcome,
      input.callbackOn,
      [recall],
      this.now(),
    );
    if (
      appointmentId !== null &&
      !(await this.repo.appointmentOfPatient(appointmentId, recall.patientId))
    ) {
      throw new BadRequestException(APPOINTMENT_NOT_OF_PATIENT_MESSAGE);
    }
    return this.repo.createContact({
      recallId: recall.id,
      patientId: recall.patientId,
      locationId: recall.locationId,
      channel: input.channel,
      outcome: input.outcome,
      note,
      appointmentId,
      authorId,
      callbackOn,
    });
  }
}

export interface CreateRecallContactsBatchInput {
  recallIds: string[];
  channel: RecallContactChannel;
  outcome: RecallContactOutcome;
  note?: string | null;
  callbackOn?: string | null;
}

export const BATCH_EMPTY_MESSAGE = 'Elige al menos un paciente de la lista.';
export const BATCH_TOO_MANY_MESSAGE = `Se registran hasta ${RECALL_BATCH_MAX} intentos a la vez.`;
export const BATCH_DUPLICATE_MESSAGE =
  'Un mismo recall aparece más de una vez en la lista.';
export const BATCH_NO_BOOKED_MESSAGE =
  '«Agendó» no se registra en lote: se registra al crear la cita de cada paciente.';

/**
 * DX-465 (D5) · «Registrar intento» para varios pacientes de la lista a la
 * vez: mismo canal, desenlace, nota y (con «Llamar luego») fecha. Todo o nada
 * en una transacción: los mismos permisos y sede que el suelto, por recall
 * (uno de una sede no permitida da 403 y no se registra ninguno). Sin
 * «Agendó» (exige la cita de cada uno). «Llamar luego» exige la fecha aquí
 * (contrato nuevo: no hay clientes anteriores que la omitan).
 */
@Injectable()
export class CreateRecallContactsBatchUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(RECALL_CLOCK) private readonly now: RecallClock,
  ) {}

  async execute(
    input: CreateRecallContactsBatchInput,
    authorId: string,
    audit: AuditRequestContext,
  ): Promise<RecallContactView[]> {
    const ids = input.recallIds.map((id) => id.toLowerCase());
    if (ids.length === 0) throw new BadRequestException(BATCH_EMPTY_MESSAGE);
    if (ids.length > RECALL_BATCH_MAX) {
      throw new BadRequestException(BATCH_TOO_MANY_MESSAGE);
    }
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException(BATCH_DUPLICATE_MESSAGE);
    }
    if (input.outcome === 'BOOKED') {
      throw new BadRequestException(BATCH_NO_BOOKED_MESSAGE);
    }
    if (input.outcome === 'CALL_BACK' && !input.callbackOn) {
      throw new BadRequestException(CALLBACK_ON_REQUIRED_MESSAGE);
    }
    const note = cleanNote(input.note);
    const found = await this.repo.findRecalls(ids);
    const byId = new Map(found.map((r) => [r.id, r]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: BATCH_NOT_FOUND_MESSAGE,
        recallIds: missing,
      });
    }
    const recalls = ids.map((id) => byId.get(id)!);
    // DX-089: cada uno por la sede de su paciente, como el suelto.
    for (const recall of recalls) {
      this.tenantContext.assertLocationAllowed(recall.locationId);
    }
    const callbackOn = checkedCallbackOn(
      input.outcome,
      input.callbackOn,
      recalls,
      this.now(),
    );
    return this.repo.createContactsBatch(
      {
        recalls,
        channel: input.channel,
        outcome: input.outcome,
        note,
        callbackOn,
        authorId,
      },
      audit,
    );
  }
}

export const BATCH_NOT_FOUND_MESSAGE =
  'Algún recall de la lista no existe en esta clínica.';
export const RECALL_SETTINGS_LOCATION_NOT_FOUND_MESSAGE = 'Sede no encontrada';

/** DX-465 (D2): días de ocultación y tope de intentos de cada sede viva. */
@Injectable()
export class ListRecallSettingsUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
  ) {}

  execute(): Promise<LocationRecallSettingsView[]> {
    return this.repo.listSettings();
  }
}

/**
 * DX-465 (D2): reemplaza los de UNA sede. La sede se comprueba bajo RLS: una
 * de otra clínica da 404, como una inexistente. Se ven al instante en la
 * lista (se evalúan al leer).
 */
@Injectable()
export class UpdateRecallSettingsUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
  ) {}

  async execute(
    locationId: string,
    values: RecallSettingsValues,
    audit: AuditRequestContext,
  ): Promise<LocationRecallSettingsView> {
    const error = recallSettingsError(values);
    if (error) throw new BadRequestException(error);
    const saved = await this.repo.saveSettings(locationId, values, audit);
    if (!saved) {
      throw new NotFoundException(RECALL_SETTINGS_LOCATION_NOT_FOUND_MESSAGE);
    }
    return saved;
  }
}

/**
 * DX-465 (D4) · «Ya está corregido»: quita la marca de teléfono por revisar
 * sin cambiar el número (p. ej. se confirmó que era correcto). Cambiar el
 * teléfono la quita sola. Idempotente: sin marca, nada que hacer.
 */
@Injectable()
export class ClearPhoneReviewUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
  ) {}

  async execute(
    patientId: string,
    audit: AuditRequestContext,
  ): Promise<{ patientId: string; cleared: boolean }> {
    const cleared = await this.repo.clearPhoneReview(patientId, audit);
    if (cleared === null) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    return { patientId, cleared };
  }
}
