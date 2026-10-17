import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AppointmentStatus,
  ClinicRole,
  WaitlistOfferChannel,
  WaitlistOfferOutcome,
  WaitlistPriority,
} from '@prisma/client';
import type { AppointmentTypeSummary } from '../../../appointment-types/domain/entities/appointment-type.entity';
import {
  LOCATION_REPOSITORY,
  type Location,
  type LocationRepository,
} from '../../../locations/domain/ports/location-repository.port';
import {
  STAFF_REPOSITORY,
  type StaffRepository,
} from '../../../staff/domain/ports/staff-repository.port';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  addCivilDays,
  zonedStartOfDay,
} from '../../../../shared/time/civil-day';
import {
  OPENING_MAX_MINUTES,
  rankOpeningCandidates,
  type CandidateSlot,
} from '../../domain/opening-candidates';
import {
  OPENING_CANDIDATES_REPOSITORY,
  type CandidatePatient,
  type OpeningCandidatesRepository,
  type WaitlistOffer,
} from '../../domain/ports/opening-candidates-repository.port';
import {
  DENTIST_OWN_COLUMN_MESSAGE,
  OFFER_ALREADY_RESOLVED_MESSAGE,
  OFFER_APPOINTMENT_MISMATCH_MESSAGE,
  OFFER_ENTRY_MISMATCH_MESSAGE,
  OFFER_NOT_FOUND_MESSAGE,
  OFFER_SLOT_INVALID_MESSAGE,
  OFFER_SLOT_PAST_MESSAGE,
  OFFER_WHATSAPP_BLOCKED_MESSAGE,
  OFFER_WHATSAPP_NO_MOBILE_MESSAGE,
  OFFER_WHATSAPP_OUTCOME_MESSAGE,
  WAITLIST_OFFER_CONFIG,
  offerCapMessage,
  offerDayFor,
  whatsappOfferPhone,
  type WaitlistOfferConfig,
} from '../../domain/waitlist-offer-rules';
import { WAITLIST_NOT_FOUND_MESSAGE } from '../../domain/waitlist-rules';

/** Reloj de las ofertas (el día de hoy en la zona de la sede); los tests lo fijan. */
export const OPENING_CLOCK = Symbol('OPENING_CLOCK');
export type OpeningClock = () => Date;

const MINUTE = 60_000;

/** Un candidato tal como lo pinta el panel «Ocupar este hueco». */
export interface OpeningCandidate {
  kind: 'WAITLIST' | 'APPOINTMENT';
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  /** Teléfono tal como está guardado (para «Llamar»). */
  phone: string | null;
  /** E.164 sin `+` para `wa.me`; `null` si no se le puede escribir. */
  whatsappPhone: string | null;
  /** Baja de los avisos o canal «Ninguno» (DX-128): no se le escribe. */
  whatsappBlocked: boolean;
  waitlistEntryId: string | null;
  appointmentId: string | null;
  priority: WaitlistPriority;
  durationMinutes: number;
  appointmentType: AppointmentTypeSummary | null;
  /** Motivo de la cita o nota del pendiente. */
  reason: string | null;
  preferredWindow: string | null;
  /** Profesional preferido (pendiente) o el de la cita. */
  providerId: string | null;
  /** La cita que se adelantaría (solo `APPOINTMENT`). */
  currentAppointment: {
    id: string;
    start: Date;
    end: Date;
    providerId: string;
    status: AppointmentStatus;
  } | null;
  /** Desde cuándo espera (alta del pendiente o creación de la cita). */
  waitingSince: Date;
  offersToday: number;
  offeredForSlot: boolean;
}

export interface OpeningCandidatesView {
  locationId: string;
  providerId: string | null;
  start: Date;
  end: Date;
  timeZone: string;
  /** Tope de ofertas por paciente y día (configurable). */
  offerCap: number;
  items: OpeningCandidate[];
  truncated: boolean;
}

export interface OpeningSlotInput {
  locationId: string;
  start: Date;
  end: Date;
  providerId?: string;
}

export interface OpeningActor {
  userId: string;
  role: ClinicRole | null;
}

function assertSlot(start: Date, end: Date, now: Date): void {
  const minutes = (end.getTime() - start.getTime()) / MINUTE;
  if (Number.isNaN(minutes) || minutes <= 0 || minutes > OPENING_MAX_MINUTES) {
    throw new BadRequestException(OFFER_SLOT_INVALID_MESSAGE);
  }
  if (end.getTime() <= now.getTime()) {
    throw new BadRequestException(OFFER_SLOT_PAST_MESSAGE);
  }
}

async function requireLocation(
  locations: LocationRepository,
  id: string,
): Promise<Location> {
  const location = await locations.findById(id);
  if (!location) throw new NotFoundException('Sede no encontrada');
  return location;
}

async function requireProvider(
  staff: StaffRepository,
  id: string,
): Promise<void> {
  if (!(await staff.findById(id))) {
    throw new NotFoundException('Profesional no encontrado');
  }
}

function contactOf(patient: CandidatePatient, country: string) {
  const wa = whatsappOfferPhone(patient, country);
  return {
    patientId: patient.id,
    patientFirstName: patient.firstName,
    patientLastName: patient.lastName,
    phone: patient.phone,
    whatsappPhone: wa.phone,
    whatsappBlocked: wa.blocked,
  };
}

/**
 * «Ocupar este hueco» (DX-210): quién de la sede podría ocupar un hueco libre
 * — pendientes de la lista que caben y citas marcadas «Adelantar si hay
 * hueco» de días posteriores —, con cuántas ofertas lleva hoy cada uno.
 */
@Injectable()
export class ListOpeningCandidatesUseCase {
  constructor(
    @Inject(OPENING_CANDIDATES_REPOSITORY)
    private readonly repo: OpeningCandidatesRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(STAFF_REPOSITORY)
    private readonly staff: StaffRepository,
    @Inject(WAITLIST_OFFER_CONFIG)
    private readonly config: WaitlistOfferConfig,
    @Inject(OPENING_CLOCK)
    private readonly clock: OpeningClock,
  ) {}

  async execute(
    input: OpeningSlotInput,
    actor: OpeningActor,
  ): Promise<OpeningCandidatesView> {
    // El odontólogo ve los candidatos de SU columna, no los de la agenda de otro.
    if (actor.role === 'DENTIST' && input.providerId !== actor.userId) {
      throw new ForbiddenException(DENTIST_OWN_COLUMN_MESSAGE);
    }
    const now = this.clock();
    assertSlot(input.start, input.end, now);
    const location = await requireLocation(this.locations, input.locationId);
    if (input.providerId) await requireProvider(this.staff, input.providerId);

    const timeZone = location.timeZone;
    const slot: CandidateSlot = {
      locationId: location.id,
      providerId: input.providerId ?? null,
      start: input.start,
      end: input.end,
      timeZone,
    };
    const slotMinutes = (input.end.getTime() - input.start.getTime()) / MINUTE;
    const nextDay = addCivilDays(offerDayFor(input.start, timeZone), 1);
    const [entries, appointments] = await Promise.all([
      this.repo.listOpenEntries({
        locationId: location.id,
        maxDurationMinutes: slotMinutes,
      }),
      this.repo.listWantsEarlier({
        locationId: location.id,
        from: zonedStartOfDay(nextDay, timeZone),
        providerId: slot.providerId,
      }),
    ]);
    const ranked = rankOpeningCandidates(slot, { entries, appointments });
    const summary = await this.repo.offersSummary({
      patientIds: [...new Set(ranked.items.map((i) => i.source.patient.id))],
      offerDay: offerDayFor(now, timeZone),
      locationId: location.id,
      slotStart: input.start,
      slotEnd: input.end,
    });

    const items = ranked.items.map((item): OpeningCandidate => {
      const offers = summary.get(item.source.patient.id);
      const common = {
        ...contactOf(item.source.patient, location.country),
        appointmentType: item.source.appointmentType,
        offersToday: offers?.today ?? 0,
        offeredForSlot: offers?.forSlot ?? false,
        waitingSince: item.source.createdAt,
      };
      if (item.kind === 'WAITLIST') {
        const e = item.source;
        return {
          ...common,
          kind: 'WAITLIST',
          waitlistEntryId: e.id,
          appointmentId: null,
          priority: e.priority,
          durationMinutes: e.durationMinutes,
          reason: e.note,
          preferredWindow: e.preferredWindow,
          providerId: e.providerId,
          currentAppointment: null,
        };
      }
      const a = item.source;
      return {
        ...common,
        kind: 'APPOINTMENT',
        waitlistEntryId: null,
        appointmentId: a.id,
        priority: 'NORMAL',
        durationMinutes: Math.round(
          (a.end.getTime() - a.start.getTime()) / MINUTE,
        ),
        reason: a.reason,
        preferredWindow: null,
        providerId: a.providerId,
        currentAppointment: {
          id: a.id,
          start: a.start,
          end: a.end,
          providerId: a.providerId,
          status: a.status,
        },
      };
    });

    return {
      locationId: location.id,
      providerId: slot.providerId,
      start: input.start,
      end: input.end,
      timeZone,
      offerCap: this.config.offersPerPatientPerDay,
      items,
      truncated: ranked.truncated,
    };
  }
}

export interface CreateWaitlistOfferInput {
  locationId: string;
  slotStart: Date;
  slotEnd: Date;
  providerId: string;
  patientId: string;
  waitlistEntryId?: string;
  appointmentId?: string;
  channel: WaitlistOfferChannel;
  /** Solo por teléfono: lo que respondió al llamarlo. */
  outcome?: WaitlistOfferOutcome;
}

export interface WaitlistOfferView extends WaitlistOffer {
  offersToday: number;
  offerCap: number;
}

function offerAudit(
  audit: RecordAuditEventUseCase,
  ctx: AuditRequestContext,
  offer: WaitlistOffer,
  action: 'CREATE' | 'UPDATE',
  reason: string,
): Promise<void> {
  return audit.record({
    tenantId: ctx.tenantId,
    locationId: offer.locationId,
    actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
    action,
    resourceType: 'WAITLIST_OFFER',
    resourceId: offer.id,
    patient: { kind: 'patient', id: offer.patientId },
    requestId: ctx.requestId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { reason },
  });
}

/**
 * «Ofrecer por WhatsApp» / «Llamé» (DX-210): registra que se le ofreció el
 * hueco al paciente. Tope de N ofertas por paciente y día (zona de la sede);
 * por WhatsApp solo si DX-128 lo permite. Queda auditada (quién, a quién y
 * cuándo; nunca el texto del mensaje).
 */
@Injectable()
export class CreateWaitlistOfferUseCase {
  constructor(
    @Inject(OPENING_CANDIDATES_REPOSITORY)
    private readonly repo: OpeningCandidatesRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(STAFF_REPOSITORY)
    private readonly staff: StaffRepository,
    private readonly audit: RecordAuditEventUseCase,
    @Inject(WAITLIST_OFFER_CONFIG)
    private readonly config: WaitlistOfferConfig,
    @Inject(OPENING_CLOCK)
    private readonly clock: OpeningClock,
  ) {}

  async execute(
    input: CreateWaitlistOfferInput,
    ctx: AuditRequestContext,
  ): Promise<WaitlistOfferView> {
    if (input.waitlistEntryId && input.appointmentId) {
      throw new BadRequestException(
        'Indica el pendiente o la cita a adelantar, no los dos',
      );
    }
    const outcome = input.outcome ?? 'PENDING';
    if (input.channel === 'WA_ME' && outcome !== 'PENDING') {
      throw new BadRequestException(OFFER_WHATSAPP_OUTCOME_MESSAGE);
    }
    const now = this.clock();
    assertSlot(input.slotStart, input.slotEnd, now);
    const location = await requireLocation(this.locations, input.locationId);
    await requireProvider(this.staff, input.providerId);
    const patient = await this.repo.patientContact(input.patientId);
    if (!patient) throw new NotFoundException('Paciente no encontrado');

    if (input.waitlistEntryId) {
      const target = await this.repo.entryTarget(input.waitlistEntryId);
      if (!target) throw new NotFoundException(WAITLIST_NOT_FOUND_MESSAGE);
      if (
        !target.active ||
        target.patientId !== patient.id ||
        target.locationId !== location.id
      ) {
        throw new ConflictException(OFFER_ENTRY_MISMATCH_MESSAGE);
      }
    }
    if (input.appointmentId) {
      const target = await this.repo.appointmentTarget(input.appointmentId);
      if (!target) throw new NotFoundException('Cita no encontrada');
      if (
        !target.active ||
        target.patientId !== patient.id ||
        target.locationId !== location.id
      ) {
        throw new ConflictException(OFFER_APPOINTMENT_MISMATCH_MESSAGE);
      }
    }
    if (input.channel === 'WA_ME') {
      const wa = whatsappOfferPhone(patient, location.country);
      if (wa.blocked) {
        throw new ConflictException(OFFER_WHATSAPP_BLOCKED_MESSAGE);
      }
      if (!wa.phone) {
        throw new ConflictException(OFFER_WHATSAPP_NO_MOBILE_MESSAGE);
      }
    }

    const cap = this.config.offersPerPatientPerDay;
    const created = await this.repo.createOffer(
      {
        locationId: location.id,
        slotStart: input.slotStart,
        slotEnd: input.slotEnd,
        providerId: input.providerId,
        patientId: patient.id,
        waitlistEntryId: input.waitlistEntryId ?? null,
        appointmentId: input.appointmentId ?? null,
        channel: input.channel,
        outcome,
        offerDay: offerDayFor(now, location.timeZone),
        createdById: ctx.actor.userId,
      },
      cap,
    );
    if (!created) throw new ConflictException(offerCapMessage(cap));
    await offerAudit(
      this.audit,
      ctx,
      created.offer,
      'CREATE',
      input.channel === 'WA_ME' ? 'OFFER_WA_ME' : `OFFER_PHONE_${outcome}`,
    );
    return {
      ...created.offer,
      offersToday: created.offersToday,
      offerCap: cap,
    };
  }
}

/** Respuesta del paciente a una oferta pendiente (p. ej. contestó el WhatsApp). */
@Injectable()
export class RecordWaitlistOfferOutcomeUseCase {
  constructor(
    @Inject(OPENING_CANDIDATES_REPOSITORY)
    private readonly repo: OpeningCandidatesRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  async execute(
    id: string,
    outcome: Exclude<WaitlistOfferOutcome, 'PENDING'>,
    ctx: AuditRequestContext,
  ): Promise<WaitlistOffer> {
    const current = await this.repo.findOffer(id);
    if (!current) throw new NotFoundException(OFFER_NOT_FOUND_MESSAGE);
    const updated = await this.repo.recordOutcome(
      id,
      outcome,
      ctx.actor.userId,
    );
    if (!updated) throw new ConflictException(OFFER_ALREADY_RESOLVED_MESSAGE);
    await offerAudit(this.audit, ctx, updated, 'UPDATE', `OFFER_${outcome}`);
    return updated;
  }
}
