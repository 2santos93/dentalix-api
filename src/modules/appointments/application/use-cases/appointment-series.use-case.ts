import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ClinicRole } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  SCHEDULE_BLOCKED_RACE_MESSAGE,
  ScheduleBlockedRaceError,
} from '../../../schedule-blocks/domain/schedule-block-rules';
import { LOCATION_REPOSITORY } from '../../../locations/domain/ports/location-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import { requireLocationTimeZone } from '../../../../shared/locations/location-time-zone';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { resolveCatalogLanguage } from '../../../../shared/i18n/patient-language';
import { randomUUID } from 'node:crypto';
import {
  EmailOutbox,
  type PreparedEmail,
} from '../../../notifications/email/application/email-outbox.service';
import { OutboundMessages } from '../../../notifications/outbound/application/outbound-messages.service';
import {
  DEFAULT_EMAIL_LOCALE,
  EMAIL_LOCALES,
} from '../../../notifications/email/domain/email-message';
import { noticeRecipient } from '../../../patients/domain/communication/notice-recipient';
import { emailReminderBlocker } from '../../../reminders/domain/reminder-eligibility';
import { firstNameOnly } from '../../../appointment-confirmations/application/confirmation-token';
import type { Appointment } from '../../domain/entities/appointment.entity';
import {
  APPOINTMENT_SERIES_REPOSITORY,
  SeriesSlotWriteError,
  type AppointmentSeriesRepository,
  type AppointmentSeriesSnapshot,
  type SeriesNoticeContext,
  type SeriesNoticeWrite,
} from '../../domain/ports/appointment-series-repository.port';
import {
  SeriesRecurrenceError,
  overlappingWithin,
  seriesDates,
  shiftedStart,
} from '../../domain/series-dates';
import { cancellationAuditMetadata } from '../../domain/cancellation-audit';
import {
  APPOINTMENT_SERIES_CONFLICT_CODE,
  SERIES_MESSAGES,
  SERIES_PENDING_STATUSES,
  followingAppointments,
  reasonFromFailure,
  seriesConflict,
  type SeriesConflict,
  type SeriesConflictReason,
} from '../series-conflicts';
import type { SlotRuleFailure } from '../slot-rule-failure';
import type { Warnings } from '../appointment-warnings';
import {
  OVERLAP_MESSAGES,
  overlapExclusionScope,
} from '../appointment-overlap-error';
import { ChairAssignmentService } from '../chair-assignment';
import {
  CreateAppointmentUseCase,
  type SeriesSlotContext,
} from './create-appointment.use-case';
import {
  UpdateAppointmentUseCase,
  type CancellationRequest,
} from './update-appointment.use-case';
import { FindOpeningsUseCase } from './find-openings.use-case';

/** Lo común de la cita base de una serie (como agendar una cita suelta). */
export interface SeriesBaseInput {
  patientId: string;
  providerId?: string;
  chairId?: string;
  appointmentTypeId?: string;
  /** Inicio de la cita base: fija la hora de pared de toda la serie. */
  start: Date;
  /** Fin de la cita base (o la duración del tipo): la duración de todas. */
  end?: Date;
  reason?: string;
  notes?: string;
}

export interface PreviewSeriesInput extends SeriesBaseInput {
  intervalWeeks: number;
  count?: number;
  until?: string;
}

export interface CreateSeriesInput extends SeriesBaseInput {
  intervalWeeks: number;
  /** Las fechas finales (la propuesta o la hora elegida); las omitidas no van. */
  occurrences: { start: Date }[];
  /** Mandar el aviso único al paciente (por defecto sí). */
  notifyPatient: boolean;
}

/** Una alternativa del mismo día: el hueco libre más cercano a la hora. */
export interface SeriesAlternative {
  start: Date;
  end: Date;
}

export interface SeriesPreviewOccurrence {
  index: number;
  /** Al mover: la cita de la serie y su franja de ahora. */
  appointmentId?: string;
  from?: { start: Date; end: Date };
  start: Date;
  end: Date;
  status: 'OK' | 'CONFLICT';
  reasons: SeriesConflictReason[];
  warnings: string[];
  warningCodes: Warnings['warningCodes'];
  alternative: SeriesAlternative | null;
}

export interface SeriesPreview {
  timeZone: string;
  durationMinutes: number;
  occurrences: SeriesPreviewOccurrence[];
}

/**
 * DX-562: por qué no se encoló el aviso de la serie. `DISABLED`: se pidió
 * sin aviso; `OPTED_OUT`, `CHANNEL_NONE`, `CHANNEL_WHATSAPP`, `NO_EMAIL`: la
 * regla de los envíos automáticos (DX-128, DX-203); `QUOTA`: el tope de
 * emails (de la clínica o del destinatario) no lo deja, la serie se crea
 * igual; `UNAVAILABLE`: no se pudo preparar (p. ej. la sede sin formato).
 */
export const SERIES_NOTIFY_SKIP_REASONS = [
  'DISABLED',
  'OPTED_OUT',
  'CHANNEL_NONE',
  'CHANNEL_WHATSAPP',
  'NO_EMAIL',
  'QUOTA',
  'UNAVAILABLE',
] as const;
export type SeriesNotifySkipReason =
  (typeof SERIES_NOTIFY_SKIP_REASONS)[number];

export interface CreatedSeries {
  seriesId: string;
  intervalWeeks: number;
  appointments: Appointment[];
  /** Si se encoló el aviso único al paciente. */
  patientNotified: boolean;
  /** Si no se encoló, por qué; `null` si se encoló. */
  notifyReason: SeriesNotifySkipReason | null;
}

/** El aviso listo para la transacción, con lo que hay que hacer tras ella. */
interface PreparedNotice {
  write: SeriesNoticeWrite;
  prepared: PreparedEmail;
}

export interface SeriesChangeResult {
  seriesId: string;
  appointments: Appointment[];
}

export interface MoveSeriesInput {
  fromAppointmentId: string;
  start: Date;
}

export interface CancelSeriesInput {
  fromAppointmentId: string;
  cancellation: CancellationRequest;
}

const MINUTE_MS = 60_000;

/** Una fecha revisada: sus fallos (en razones) y sus avisos. */
interface CheckedSlot {
  start: Date;
  end: Date;
  reasons: SeriesConflictReason[];
  warnings: Warnings;
}

/**
 * DX-562: citas en serie. Vista previa (sin estado), creación atómica, y
 * cancelar o mover «esta y las siguientes». Cada fecha pasa por EXACTAMENTE
 * las reglas de la cita suelta (CreateAppointmentUseCase al crear,
 * UpdateAppointmentUseCase al mover), pero se juntan todos los fallos de
 * todas las fechas para la vista previa y el 409.
 */
@Injectable()
export class AppointmentSeriesUseCase {
  private readonly logger = new Logger('AppointmentSeries');

  constructor(
    private readonly create: CreateAppointmentUseCase,
    private readonly update: UpdateAppointmentUseCase,
    private readonly openings: FindOpeningsUseCase,
    private readonly chairs: ChairAssignmentService,
    @Inject(APPOINTMENT_SERIES_REPOSITORY)
    private readonly series: AppointmentSeriesRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    private readonly email: EmailOutbox,
    private readonly tenantContext: TenantContextService,
    private readonly outbound: OutboundMessages,
  ) {}

  // ---------------------------------------------------------------------------
  // Crear
  // ---------------------------------------------------------------------------

  /** D3: las fechas de la serie y si cada una se puede agendar. No escribe. */
  async preview(
    input: PreviewSeriesInput,
    ctx: AuditRequestContext,
  ): Promise<SeriesPreview> {
    const context = await this.create.prepareSeries(
      this.baseInput(input, ctx.actor.role),
    );
    const timeZone = await this.timeZoneOf(context.input.locationId);
    const slots = this.generate(input, context, timeZone);
    const checked = await this.checkNewSlots(context, slots);
    const occurrences: SeriesPreviewOccurrence[] = [];
    for (const [i, slot] of checked.entries()) {
      occurrences.push(
        await this.previewOccurrence(i + 1, slot, {
          context,
          timeZone,
          excludeAppointmentId: undefined,
        }),
      );
    }
    return {
      timeZone,
      durationMinutes: Math.round(context.durationMs / MINUTE_MS),
      occurrences,
    };
  }

  /**
   * D4: crea la serie con las fechas finales que manda la web, en UNA
   * transacción. Si alguna ya no se puede agendar (revisión previa o la BD
   * como árbitro), 409 `APPOINTMENT_SERIES_CONFLICT` con TODAS las que chocan
   * y no se crea ninguna.
   */
  async createSeries(
    input: CreateSeriesInput,
    ctx: AuditRequestContext,
  ): Promise<CreatedSeries> {
    const context = await this.create.prepareSeries(
      this.baseInput(input, ctx.actor.role),
    );
    const starts = input.occurrences
      .map((o) => o.start)
      .sort((a, b) => a.getTime() - b.getTime());
    if (new Set(starts.map((s) => s.getTime())).size !== starts.length) {
      throw new BadRequestException(SERIES_MESSAGES.duplicateStarts);
    }
    const slots = starts.map((start) => ({
      start,
      end: new Date(start.getTime() + context.durationMs),
    }));
    const checked = await this.checkNewSlots(context, slots);
    const conflicts = conflictsOf(
      checked.map((c, i) => ({ ...c, index: i + 1 })),
    );
    if (conflicts.length > 0) throw seriesConflict(conflicts);

    const notice: PreparedNotice | SeriesNotifySkipReason = input.notifyPatient
      ? await this.prepareNotice(context, slots)
      : 'DISABLED';
    const prepared = typeof notice === 'string' ? null : notice;
    let created: Awaited<ReturnType<AppointmentSeriesRepository['create']>>;
    try {
      created = await this.series.create({
        intervalWeeks: input.intervalWeeks,
        patientId: context.input.patientId,
        providerId: context.input.providerId,
        locationId: context.input.locationId,
        chairId: context.chair?.id ?? null,
        appointmentTypeId: context.input.appointmentTypeId ?? null,
        reason: context.input.reason ?? null,
        notes: context.input.notes ?? null,
        createdById: ctx.actor.userId,
        actorRole: ctx.actor.role,
        slots,
        audit: ctx,
        email: prepared?.write ?? null,
      });
    } catch (error) {
      throw await this.writeConflict(error, (at) =>
        'position' in at
          ? {
              index: at.position + 1,
              start: slots[at.position].start,
              end: slots[at.position].end,
              chairId: context.chair?.id ?? null,
            }
          : null,
      );
    }
    // Tras el COMMIT: el log y el despachador, solo si quedó encolado.
    if (prepared && created.notice === 'QUEUED') {
      prepared.prepared.kick();
      this.outbound.logRecorded(prepared.write.outbound.id, ctx.tenantId, {
        channel: 'EMAIL',
        template: 'appointment-series',
        recipient: prepared.write.outbound.recipient,
        recipientKind: prepared.write.outbound.recipientKind,
        appointmentId: created.appointments[0]?.id,
        language: prepared.write.outbound.language,
        languageFallbackFrom: prepared.write.outbound.languageFallbackFrom,
      });
    }
    const notifyReason: SeriesNotifySkipReason | null =
      typeof notice === 'string'
        ? notice
        : created.notice === 'QUEUED'
          ? null
          : 'QUOTA';
    if (notifyReason === 'QUOTA') this.skipNotice('QUOTA');
    return {
      seriesId: created.seriesId,
      intervalWeeks: input.intervalWeeks,
      appointments: created.appointments,
      patientNotified: notifyReason === null,
      notifyReason,
    };
  }

  // ---------------------------------------------------------------------------
  // Cancelar «esta y las siguientes»
  // ---------------------------------------------------------------------------

  /**
   * D5: cancela, en UNA transacción, la cita `fromAppointmentId` y las
   * siguientes de la serie que siguen pendientes y no empezaron; cada una con
   * las reglas y los datos de cancelarla suelta, sin «Pendientes por
   * agendar». Las atendidas, en clínica, canceladas y anteriores no se tocan.
   * Sin ninguna que cancelar: 200 con la lista vacía.
   */
  async cancelFollowing(
    seriesId: string,
    input: CancelSeriesInput,
    ctx: AuditRequestContext,
  ): Promise<SeriesChangeResult> {
    const { snapshot, pivot } = await this.loadPivot(
      seriesId,
      input.fromAppointmentId,
    );
    const targets = followingAppointments(
      snapshot.appointments,
      pivot.series!.index,
      new Date(),
    );
    const changes = [];
    for (const appointment of targets) {
      changes.push({
        id: appointment.id,
        patch: await this.update.planSeriesCancellation(
          appointment,
          input.cancellation,
          ctx,
        ),
      });
    }
    if (changes.length === 0) {
      return { seriesId, appointments: [] };
    }
    let appointments: Appointment[];
    try {
      appointments = await this.series.applyChanges({
        seriesId,
        changes,
        lock: null,
        markCancelledBy: ctx.actor.userId,
        auditEvent: (updated) => ({
          ...this.auditBase(ctx, updated[0]),
          action: 'UPDATE',
          metadata: {
            reason: 'APPOINTMENT_SERIES_CANCELLED',
            appointmentSeries: {
              seriesId,
              appointmentIds: updated.map((a) => a.id),
            },
            // La primera cancelada es la de menos aviso: la única que puede
            // ser tardía (las siguientes empiezan después).
            ...cancellationAuditMetadata(updated[0]),
          },
        }),
      });
    } catch (error) {
      throw await this.writeConflict(error, () => null);
    }
    return { seriesId, appointments };
  }

  // ---------------------------------------------------------------------------
  // Mover «esta y las siguientes»
  // ---------------------------------------------------------------------------

  /** D6: cómo quedarían la cita y las siguientes al moverlas. No escribe. */
  async previewMove(
    seriesId: string,
    input: MoveSeriesInput,
    ctx: AuditRequestContext,
  ): Promise<SeriesPreview> {
    const plan = await this.planMove(seriesId, input, ctx);
    const occurrences: SeriesPreviewOccurrence[] = [];
    for (const item of plan.items) {
      occurrences.push(
        await this.previewOccurrence(item.appointment.series!.index, item, {
          context: null,
          appointment: item.appointment,
          timeZone: plan.timeZone,
          excludeAppointmentId: item.appointment.id,
        }),
      );
    }
    return {
      timeZone: plan.timeZone,
      durationMinutes: Math.round(
        (plan.pivot.end.getTime() - plan.pivot.start.getTime()) / MINUTE_MS,
      ),
      occurrences,
    };
  }

  /**
   * D6: mueve la cita y las siguientes en UNA transacción (los mismos días de
   * desplazamiento y la nueva hora de pared, cada una con su duración). Si
   * alguna choca, 409 `APPOINTMENT_SERIES_CONFLICT` con todas y no se mueve
   * ninguna; la web pide ajustarlas una a una.
   */
  async moveFollowing(
    seriesId: string,
    input: MoveSeriesInput,
    ctx: AuditRequestContext,
  ): Promise<SeriesChangeResult> {
    const plan = await this.planMove(seriesId, input, ctx);
    const conflicts = conflictsOf(
      plan.items.map((item) => ({
        ...item,
        index: item.appointment.series!.index,
        appointmentId: item.appointment.id,
      })),
    );
    if (conflicts.length > 0) throw seriesConflict(conflicts);
    // Hacia delante se escribe desde la última (cada una deja libre la hora
    // a la que llega la anterior); hacia atrás, desde la primera.
    const later = input.start.getTime() > plan.pivot.start.getTime();
    const ordered = later ? [...plan.items].reverse() : plan.items;
    let appointments: Appointment[];
    try {
      appointments = await this.series.applyChanges({
        seriesId,
        changes: ordered.map((item) => ({
          id: item.appointment.id,
          patch: this.update.planSeriesMove(item.appointment, item, ctx),
        })),
        lock: {
          providerIds: plan.items.map((i) => i.appointment.providerId),
          locationId: plan.pivot.locationId,
        },
        markCancelledBy: null,
        auditEvent: (updated) => {
          const byIndex = [...updated].sort(
            (a, b) => a.series!.index - b.series!.index,
          );
          return {
            ...this.auditBase(ctx, byIndex[0]),
            action: 'UPDATE',
            metadata: {
              reason: 'APPOINTMENT_SERIES_MOVED',
              appointmentSeries: {
                seriesId,
                appointmentIds: byIndex.map((a) => a.id),
                dates: byIndex.map((a) => a.start.toISOString()),
              },
              // La cita pivote, antes y después (como APPOINTMENT_MOVED).
              move: {
                from: slotOf(plan.pivot),
                to: slotOf(byIndex[0]),
              },
            },
          };
        },
      });
    } catch (error) {
      throw await this.writeConflict(error, (at) => {
        if (!('appointmentId' in at)) return null;
        const item = plan.items.find(
          (i) => i.appointment.id === at.appointmentId,
        );
        return item
          ? {
              index: item.appointment.series!.index,
              appointmentId: item.appointment.id,
              start: item.start,
              end: item.end,
              chairId: item.appointment.chairId,
            }
          : null;
      });
    }
    appointments.sort((a, b) => a.series!.index - b.series!.index);
    return { seriesId, appointments };
  }

  // ---------------------------------------------------------------------------
  // Piezas
  // ---------------------------------------------------------------------------

  private baseInput(input: SeriesBaseInput, actorRole: ClinicRole | null) {
    return {
      patientId: input.patientId,
      providerId: input.providerId,
      chairId: input.chairId,
      appointmentTypeId: input.appointmentTypeId,
      start: input.start,
      end: input.end,
      reason: input.reason,
      notes: input.notes,
      actorRole,
    };
  }

  private async timeZoneOf(locationId: string): Promise<string> {
    const location = await this.locations.findById(locationId);
    if (!location) throw new NotFoundException('Sede no encontrada');
    return requireLocationTimeZone(location);
  }

  private generate(
    input: PreviewSeriesInput,
    context: SeriesSlotContext,
    timeZone: string,
  ): { start: Date; end: Date }[] {
    try {
      return seriesDates({
        start: context.input.start,
        end: new Date(context.input.start.getTime() + context.durationMs),
        timeZone,
        intervalWeeks: input.intervalWeeks,
        count: input.count,
        until: input.until,
      });
    } catch (error) {
      if (error instanceof SeriesRecurrenceError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /** Las reglas de agendar en cada fecha nueva, más los choques entre ellas. */
  private async checkNewSlots(
    context: SeriesSlotContext,
    slots: readonly { start: Date; end: Date }[],
  ): Promise<CheckedSlot[]> {
    const out: CheckedSlot[] = [];
    for (const slot of slots) {
      const { failures, warnings } = await this.create.checkSeriesSlot(
        context,
        slot,
      );
      out.push({
        ...slot,
        reasons: failures.map(reasonFromFailure),
        warnings,
      });
    }
    return withSeriesOverlaps(out);
  }

  private async previewOccurrence(
    index: number,
    slot: CheckedSlot & { appointment?: Appointment },
    opts: {
      context: SeriesSlotContext | null;
      appointment?: Appointment;
      timeZone: string;
      excludeAppointmentId: string | undefined;
    },
  ): Promise<SeriesPreviewOccurrence> {
    const conflict = slot.reasons.length > 0;
    return {
      index,
      ...(opts.appointment
        ? {
            appointmentId: opts.appointment.id,
            from: { start: opts.appointment.start, end: opts.appointment.end },
          }
        : {}),
      start: slot.start,
      end: slot.end,
      status: conflict ? 'CONFLICT' : 'OK',
      reasons: slot.reasons,
      warnings: conflict ? [] : slot.warnings.warnings,
      warningCodes: conflict ? [] : slot.warnings.warningCodes,
      alternative: conflict
        ? await this.alternative(slot, {
            providerId:
              opts.appointment?.providerId ?? opts.context!.input.providerId,
            locationId:
              opts.appointment?.locationId ?? opts.context!.input.locationId,
            patientId:
              opts.appointment?.patientId ?? opts.context!.input.patientId,
            chairId:
              opts.appointment?.chairId ?? opts.context?.chair?.id ?? null,
            timeZone: opts.timeZone,
            excludeAppointmentId: opts.excludeAppointmentId,
          })
        : null,
    };
  }

  /**
   * El hueco libre del MISMO día (zona de la sede) más cercano a la hora
   * propuesta, para ese profesional, sillón y duración (`FindOpeningsUseCase`:
   * horario de la sede y del profesional, bloqueos, citas del profesional y
   * del paciente, festivos, nunca el pasado). `null` si no queda ninguno (o
   * el día es festivo). La confirmación lo vuelve a revisar todo.
   */
  private async alternative(
    slot: { start: Date; end: Date; reasons: SeriesConflictReason[] },
    scope: {
      providerId: string;
      locationId: string;
      patientId: string;
      chairId: string | null;
      timeZone: string;
      excludeAppointmentId: string | undefined;
    },
  ): Promise<SeriesAlternative | null> {
    if (slot.reasons.some((r) => r.code === 'LOCATION_HOLIDAY')) return null;
    const durationMs = slot.end.getTime() - slot.start.getTime();
    const day = civilDateIn(slot.start, scope.timeZone);
    let openings: { start: Date; end: Date }[];
    try {
      ({ openings } = await this.openings.execute({
        providerId: scope.providerId,
        locationId: scope.locationId,
        from: day,
        to: day,
        durationMinutes: Math.ceil(durationMs / MINUTE_MS),
        patientId: scope.patientId,
        excludeAppointmentId: scope.excludeAppointmentId,
        chairIds: scope.chairId ? [scope.chairId] : undefined,
      }));
    } catch (error) {
      if (error instanceof HttpException) return null;
      throw error;
    }
    return closestStart(openings, slot.start, durationMs);
  }

  /** La serie y la cita pivote, que tiene que ser suya (404 si no). */
  private async loadPivot(
    seriesId: string,
    fromAppointmentId: string,
  ): Promise<{ snapshot: AppointmentSeriesSnapshot; pivot: Appointment }> {
    const snapshot = await this.series.findById(seriesId);
    if (!snapshot) throw new NotFoundException(SERIES_MESSAGES.notFound);
    const pivot = snapshot.appointments.find((a) => a.id === fromAppointmentId);
    if (!pivot?.series) {
      throw new NotFoundException(SERIES_MESSAGES.notInSeries);
    }
    this.tenantContext.assertLocationAllowed(pivot.locationId);
    return { snapshot, pivot };
  }

  private async planMove(
    seriesId: string,
    input: MoveSeriesInput,
    ctx: AuditRequestContext,
  ): Promise<{
    pivot: Appointment;
    timeZone: string;
    items: (CheckedSlot & { appointment: Appointment })[];
  }> {
    const { snapshot, pivot } = await this.loadPivot(
      seriesId,
      input.fromAppointmentId,
    );
    const now = new Date();
    if (
      !SERIES_PENDING_STATUSES.includes(pivot.status) ||
      pivot.start.getTime() <= now.getTime()
    ) {
      throw new ConflictException(SERIES_MESSAGES.pivotNotMovable);
    }
    if (input.start.getTime() === pivot.start.getTime()) {
      throw new BadRequestException(SERIES_MESSAGES.sameStart);
    }
    const targets = followingAppointments(
      snapshot.appointments,
      pivot.series!.index,
      now,
    );
    if (targets.length === 0) {
      throw new ConflictException(SERIES_MESSAGES.nothingToMove);
    }
    if (targets.some((a) => a.locationId !== pivot.locationId)) {
      throw new ConflictException(SERIES_MESSAGES.differentLocations);
    }
    const timeZone = await this.timeZoneOf(pivot.locationId);
    const movingIds = targets.map((a) => a.id);
    const items: (CheckedSlot & { appointment: Appointment })[] = [];
    for (const appointment of targets) {
      const start = shiftedStart(
        appointment.start,
        pivot.start,
        input.start,
        timeZone,
      );
      const end = new Date(
        start.getTime() +
          (appointment.end.getTime() - appointment.start.getTime()),
      );
      const failures: SlotRuleFailure[] = [];
      const warnings = await this.update.checkSeriesMove(
        appointment,
        { start, end },
        movingIds,
        ctx,
        (f) => failures.push(f),
      );
      items.push({
        appointment,
        start,
        end,
        reasons: failures.map(reasonFromFailure),
        warnings,
      });
    }
    return { pivot, timeZone, items: withSeriesOverlaps(items) };
  }

  /**
   * El aviso único al paciente, listo para insertarlo en la transacción de la
   * serie (DX-463: render y marca antes de abrirla). A quien recibe los
   * recordatorios (DX-203: un menor o sin email → su responsable), solo si
   * su canal es EMAIL, no se dio de baja (DX-128) y hay a quién mandarlo.
   * Cualquier fallo al prepararlo deja la serie sin aviso (queda en el log,
   * sin datos personales): nunca impide crearla. El tope de emails se mira
   * en la transacción (`enforceQuota`): si no cabe, tampoco la impide.
   */
  private async prepareNotice(
    context: SeriesSlotContext,
    slots: readonly { start: Date; end: Date }[],
  ): Promise<PreparedNotice | SeriesNotifySkipReason> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) return 'UNAVAILABLE';
    try {
      const notice = await this.series.noticeContext({
        patientId: context.input.patientId,
        locationId: context.input.locationId,
        providerId: context.input.providerId,
      });
      if (!notice) return this.skipNotice('UNAVAILABLE');
      const recipient = this.recipientOf(notice);
      const blocker = emailReminderBlocker({
        ...notice.contact,
        email: recipient.email,
      });
      if (blocker !== null || !recipient.email) {
        return this.skipNotice(blocker ?? 'NO_EMAIL');
      }
      const format = requireLocationFormat({
        id: context.input.locationId,
        locale: notice.locationLocale,
        hourCycle: notice.locationHourCycle,
      });
      const { language, fallbackFrom } = resolveCatalogLanguage(
        notice.preferredLanguage,
        EMAIL_LOCALES,
        DEFAULT_EMAIL_LOCALE,
      );
      // El registro del envío y el email se enlazan por este id (como el
      // recordatorio: `referenceId` = el de `outbound_messages`).
      const outboundId = randomUUID();
      const prepared = await this.email.prepareInTx({
        tenantId,
        to: recipient.email,
        template: 'appointment-series',
        locale: language,
        referenceId: outboundId,
        enforceQuota: true,
        vars: {
          recipientFirstName: recipient.name,
          patientFirstName:
            recipient.kind === 'PATIENT'
              ? null
              : firstNameOnly(notice.recipient.firstName),
          clinicName: notice.clinicName,
          locationName: notice.locationName,
          providerName: notice.providerName,
          dateLabels: slots.map((s) =>
            format.longDateTime(s.start, notice.locationTimeZone),
          ),
        },
      });
      return {
        prepared,
        write: {
          insert: (tx) => prepared.insert(tx),
          outbound: {
            id: outboundId,
            recipient: recipient.email,
            recipientKind:
              recipient.kind === 'RESPONSIBLE' ? 'RESPONSIBLE' : 'PATIENT',
            language,
            languageFallbackFrom: fallbackFrom,
          },
        },
      };
    } catch (error) {
      this.logger.warn({
        event: 'appointment_series.notice_failed',
        error: (error as Error).name,
      });
      return 'UNAVAILABLE';
    }
  }

  private recipientOf(notice: SeriesNoticeContext) {
    return noticeRecipient({
      patient: { ...notice.recipient, email: notice.contact.email },
      responsibles: notice.responsibles,
      majorityAge: notice.majorityAge,
      today: civilDateIn(new Date(), notice.locationTimeZone),
      timeZone: notice.locationTimeZone,
      majorityReview: notice.majorityReview,
      automatic: true,
    });
  }

  private skipNotice<R extends SeriesNotifySkipReason>(reason: R): R {
    this.logger.log({ event: 'appointment_series.notice_skipped', reason });
    return reason;
  }

  private auditBase(ctx: AuditRequestContext, first: Appointment) {
    return {
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: {
        kind: 'user' as const,
        userId: ctx.actor.userId,
        role: ctx.actor.role,
      },
      resourceType: 'APPOINTMENT' as const,
      resourceId: first.id,
      patient: { kind: 'patient' as const, id: first.patientId },
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    };
  }

  /**
   * Una cita de la serie no se pudo escribir dentro de la transacción (no se
   * escribió ninguna): la BD arbitró una carrera (bloqueo duro creado a la
   * vez, EXCLUDE de profesional, paciente o sillón) → 409
   * `APPOINTMENT_SERIES_CONFLICT` con esa fecha; un interbloqueo que se
   * repitió tras el reintento → el mismo 409, sin fecha; una excepción HTTP
   * de las reglas de la cita (p. ej. otra persona cambió su estado) sale tal
   * cual. Lo demás se propaga.
   */
  private async writeConflict(
    error: unknown,
    locate: (
      at: SeriesSlotWriteError['at'],
    ) => (Omit<SeriesConflict, 'reasons'> & { chairId: string | null }) | null,
  ): Promise<unknown> {
    if (!(error instanceof SeriesSlotWriteError)) {
      return isDeadlockError(error) ? busyConflict() : error;
    }
    const cause = error.cause;
    if (cause instanceof HttpException) return cause;
    if (isDeadlockError(cause)) return busyConflict();
    const slot = locate(error.at);
    let reason: SeriesConflictReason | null = null;
    if (cause instanceof ScheduleBlockedRaceError) {
      reason = {
        code: 'SCHEDULE_BLOCKED',
        message: SCHEDULE_BLOCKED_RACE_MESSAGE,
      };
    } else {
      const scope = overlapExclusionScope(cause);
      if (scope === 'provider' || scope === 'patient') {
        reason = {
          code: scope === 'provider' ? 'PROVIDER_OVERLAP' : 'PATIENT_OVERLAP',
          message: OVERLAP_MESSAGES[scope],
        };
      } else if (scope === 'chair' && slot?.chairId) {
        const chairError = await this.chairs.raceConflict(slot.chairId, slot);
        reason = {
          code: 'CHAIR_OVERLAP',
          message: chairError.message,
        };
      }
    }
    if (!reason) return error;
    if (!slot) return busyConflict();
    const { chairId: _chair, ...located } = slot;
    return seriesConflict([{ ...located, reasons: [reason] }]);
  }
}

/** La fecha y la hora de una cita para `move` (como APPOINTMENT_MOVED). */
function slotOf(a: Appointment) {
  return {
    start: a.start.toISOString(),
    end: a.end.toISOString(),
    providerId: a.providerId,
    chairId: a.chairId,
  };
}

/** Añade `SERIES_OVERLAP` a las fechas de la lista que chocan entre sí. */
function withSeriesOverlaps<T extends CheckedSlot>(slots: T[]): T[] {
  const clashing = overlappingWithin(slots);
  return slots.map((slot, i) =>
    clashing.has(i)
      ? {
          ...slot,
          reasons: [
            ...slot.reasons,
            {
              code: 'SERIES_OVERLAP' as const,
              message: SERIES_MESSAGES.seriesOverlap,
            },
          ],
        }
      : slot,
  );
}

function conflictsOf(
  slots: readonly (CheckedSlot & { index: number; appointmentId?: string })[],
): SeriesConflict[] {
  return slots
    .filter((s) => s.reasons.length > 0)
    .map((s) => ({
      index: s.index,
      ...(s.appointmentId ? { appointmentId: s.appointmentId } : {}),
      start: s.start,
      end: s.end,
      reasons: s.reasons,
    }));
}

/**
 * El inicio libre más cercano a `wanted` (empate: el posterior) dentro de
 * los huecos, alineado a 5 minutos como «Buscar hueco».
 */
export function closestStart(
  openings: readonly { start: Date; end: Date }[],
  wanted: Date,
  durationMs: number,
): SeriesAlternative | null {
  const STEP = 5 * MINUTE_MS;
  let best: number | null = null;
  for (const opening of openings) {
    const first = opening.start.getTime();
    const last = opening.end.getTime() - durationMs;
    if (last < first) continue;
    const clamped = Math.min(Math.max(wanted.getTime(), first), last);
    // Alineado a 5 min (el de abajo o el de arriba), sin salirse del hueco.
    const down = clamped - (((clamped % STEP) + STEP) % STEP);
    for (const candidate of [down, down + STEP]) {
      if (candidate < first || candidate > last) continue;
      const distance = Math.abs(candidate - wanted.getTime());
      const bestDistance =
        best === null ? Infinity : Math.abs(best - wanted.getTime());
      if (
        distance < bestDistance ||
        (distance === bestDistance && best !== null && candidate > best)
      ) {
        best = candidate;
      }
    }
  }
  return best === null
    ? null
    : { start: new Date(best), end: new Date(best + durationMs) };
}

function isDeadlockError(error: unknown): boolean {
  const message = (error as { message?: unknown })?.message;
  return (
    typeof message === 'string' &&
    (message.includes('40P01') || /deadlock detected/i.test(message))
  );
}

/** 409 de la serie sin fecha: otra escritura a la vez no dejó terminar. */
function busyConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: APPOINTMENT_SERIES_CONFLICT_CODE,
    message: SERIES_MESSAGES.busy,
    conflicts: [],
  });
}
