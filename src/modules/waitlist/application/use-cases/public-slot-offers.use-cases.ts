import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  LOCATION_SCHEDULE_REPOSITORY,
  type LocationScheduleRepository,
} from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import { fitsBusinessHours } from '../../../location-schedule/application/business-hours';
import {
  SCHEDULE_BLOCK_REPOSITORY,
  type ScheduleBlockRepository,
} from '../../../schedule-blocks/domain/ports/schedule-block-repository.port';
import { ProviderAvailabilityService } from '../../../provider-schedule/application/provider-availability.service';
import { civilDateIn } from '../../../../shared/time/civil-day';
import {
  SLOT_OFFER_MESSAGES,
  SLOT_OFFER_NOT_FOUND_MESSAGE,
  hashSlotOfferToken,
  isWellFormedSlotOfferToken,
  publicSlotOfferState,
  type PublicSlotOfferState,
} from '../../domain/slot-offer-link';
import {
  SLOT_OFFER_REPOSITORY,
  type ClinicBrandingRow,
  type PublicSlotOffer,
  type SlotOfferRepository,
} from '../../domain/ports/slot-offer-repository.port';
import { OPENING_CLOCK, type OpeningClock } from './opening-candidates.use-cases';

/**
 * Lo único que la página pública ve: nombre de pila, cuándo, con quién y
 * dónde. Nada clínico (ni motivo, ni tratamiento, ni apellidos).
 */
export interface PublicSlotOfferDetails {
  patientFirstName: string;
  start: Date;
  end: Date;
  timeZone: string;
  providerName: string | null;
  locationName: string;
  locationAddress: string | null;
  /** Si acepta, su cita de esta fecha se adelanta (y esa hora queda libre). */
  currentAppointmentStart: Date | null;
  expiresAt: Date | null;
}

export interface PublicSlotOfferView {
  state: PublicSlotOfferState;
  message: string;
  clinic: ClinicBrandingRow | null;
  /** Solo mientras está abierta o ya es suya: un enlace sin efecto no enseña el hueco. */
  offer: PublicSlotOfferDetails | null;
}

function firstNameOnly(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

function details(offer: PublicSlotOffer): PublicSlotOfferDetails {
  return {
    patientFirstName: firstNameOnly(offer.patientFirstName),
    start: offer.slotStart,
    end: offer.appointmentEnd,
    timeZone: offer.timeZone,
    providerName: offer.providerName,
    locationName: offer.locationName,
    locationAddress: offer.locationAddress,
    currentAppointmentStart: offer.currentAppointmentStart,
    expiresAt: offer.expiresAt,
  };
}

/**
 * Búsqueda común de las rutas públicas. El tenant sale SOLO del host; la RLS
 * hace invisible un token de otra clínica: mismo 404 que uno inventado.
 */
async function findOffer(
  tenantContext: TenantContextService,
  repo: SlotOfferRepository,
  token: string,
): Promise<PublicSlotOffer> {
  if (!tenantContext.getTenantId() || !isWellFormedSlotOfferToken(token)) {
    throw new NotFoundException(SLOT_OFFER_NOT_FOUND_MESSAGE);
  }
  const offer = await repo.findByTokenHash(hashSlotOfferToken(token));
  if (!offer) throw new NotFoundException(SLOT_OFFER_NOT_FOUND_MESSAGE);
  return offer;
}

async function viewOf(
  repo: SlotOfferRepository,
  offer: PublicSlotOffer,
  state: PublicSlotOfferState,
): Promise<PublicSlotOfferView> {
  return {
    state,
    message: SLOT_OFFER_MESSAGES[state],
    clinic: await repo.findClinicBranding(),
    offer: state === 'OPEN' || state === 'ACCEPTED' ? details(offer) : null,
  };
}

/** Abrir el enlace: SOLO LECTURA (los previsualizadores de WhatsApp lo abren solos). */
@Injectable()
export class GetPublicSlotOfferUseCase {
  constructor(
    @Inject(SLOT_OFFER_REPOSITORY) private readonly repo: SlotOfferRepository,
    @Inject(OPENING_CLOCK) private readonly clock: OpeningClock,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(token: string): Promise<PublicSlotOfferView> {
    const offer = await findOffer(this.tenantContext, this.repo, token);
    const now = this.clock();
    const base = publicSlotOfferState(offer, now, false);
    const state =
      base === 'OPEN' && (await this.repo.slotTaken(offer))
        ? 'UNAVAILABLE'
        : base;
    return viewOf(this.repo, offer, state);
  }
}

/**
 * «Aceptar»: crea la cita (o adelanta la marcada) con las reglas de agenda de
 * DX-210 —horario de la sede y del profesional, bloqueos y anti-solape—, en
 * una transacción donde solo una aceptación del hueco gana. Las demás ven
 * «Este hueco ya se ocupó»; nunca un 500.
 */
@Injectable()
export class AcceptSlotOfferUseCase {
  constructor(
    @Inject(SLOT_OFFER_REPOSITORY) private readonly repo: SlotOfferRepository,
    @Inject(LOCATION_SCHEDULE_REPOSITORY)
    private readonly schedule: LocationScheduleRepository,
    @Inject(SCHEDULE_BLOCK_REPOSITORY)
    private readonly blocks: ScheduleBlockRepository,
    private readonly availability: ProviderAvailabilityService,
    @Inject(OPENING_CLOCK) private readonly clock: OpeningClock,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    token: string,
    meta: AuditRequestMeta,
  ): Promise<PublicSlotOfferView> {
    const offer = await findOffer(this.tenantContext, this.repo, token);
    const now = this.clock();
    const before = publicSlotOfferState(offer, now, false);
    // Lo resuelto se contesta sin escribir; lo caducado lo marca el repo.
    if (before === 'OPEN' && !(await this.fitsAgenda(offer))) {
      return viewOf(this.repo, offer, 'UNAVAILABLE');
    }
    const result = await this.repo.accept(offer, now, meta);
    return viewOf(this.repo, offer, result.state);
  }

  /** Horario de la sede, del profesional y bloqueos, como al reagendar. */
  private async fitsAgenda(offer: PublicSlotOffer): Promise<boolean> {
    const start = offer.slotStart;
    const end = offer.appointmentEnd;
    const hours = await this.schedule.findByLocation(offer.locationId);
    if (!fitsBusinessHours(start, end, hours)) return false;
    const day = civilDateIn(start, offer.timeZone);
    const canAttend = await this.availability.attendancePredicate(
      [offer.providerId],
      offer.locationId,
      offer.timeZone,
      day,
      day,
    );
    if (!canAttend(offer.providerId, start, end)) return false;
    const affecting = await this.blocks.findAffecting({
      providerId: offer.providerId,
      start,
      end,
      locationId: offer.locationId,
    });
    return !affecting.blocks.some((b) => !b.allowsBooking);
  }
}

/** «No me viene bien»: la oferta queda DECLINED (auditada). */
@Injectable()
export class DeclineSlotOfferUseCase {
  constructor(
    @Inject(SLOT_OFFER_REPOSITORY) private readonly repo: SlotOfferRepository,
    @Inject(OPENING_CLOCK) private readonly clock: OpeningClock,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    token: string,
    meta: AuditRequestMeta,
  ): Promise<PublicSlotOfferView> {
    const offer = await findOffer(this.tenantContext, this.repo, token);
    const result = await this.repo.decline(offer, this.clock(), meta);
    return viewOf(this.repo, offer, result.state);
  }
}
