import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import {
  LOCATION_REPOSITORY,
  type LocationRepository,
} from '../../../locations/domain/ports/location-repository.port';
import {
  STAFF_REPOSITORY,
  type StaffRepository,
} from '../../../staff/domain/ports/staff-repository.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';
import { requireLocationTimeZone } from '../../../../shared/locations/location-time-zone';
import { phoneRegionOrNull } from '../../../../shared/phone/phone-number';
import {
  OPENING_CANDIDATES_REPOSITORY,
  type OpeningCandidatesRepository,
} from '../../domain/ports/opening-candidates-repository.port';
import {
  SLOT_OFFER_REPOSITORY,
  type SlotOfferRepository,
} from '../../domain/ports/slot-offer-repository.port';
import {
  LINK_OFFER_CONFIG,
  LINK_OFFER_EMAIL_FAILED_MESSAGE,
  LINK_OFFER_TOO_LATE_MESSAGE,
  OFFER_EMAIL_BLOCKED_MESSAGE,
  OFFER_EMAIL_MISSING_MESSAGE,
  buildSlotOfferUrl,
  emailOfferBlock,
  generateSlotOfferToken,
  hashSlotOfferToken,
  linkOfferExpiresAt,
  linkOfferWindowOpen,
  type LinkChannel,
  type LinkOfferConfig,
} from '../../domain/slot-offer-link';
import { whatsappOfferPhone } from '../../domain/waitlist-offer-rules';
import {
  SLOT_OFFER_EMAIL_SENDER,
  type SlotOfferEmailSender,
} from '../slot-offer-email';
import {
  CreateWaitlistOfferUseCase,
  OPENING_CLOCK,
  type CreateWaitlistOfferInput,
  type OpeningClock,
  type WaitlistOfferView,
} from './opening-candidates.use-cases';

export interface LinkOfferView extends WaitlistOfferView {
  /** Solo por WhatsApp: el enlace para el texto prellenado de `wa.me`. */
  url: string | null;
  /** E.164 sin `+` para `wa.me` (solo por WhatsApp). */
  whatsappPhone: string | null;
}

export interface PublicLinkBase {
  protocol: 'http' | 'https';
  /** Host de la clínica ya validado (`safeLinkHost`). */
  host: string;
}

function firstNameOnly(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

/**
 * «Enviar oferta con enlace» (DX-435): la oferta de DX-210 (mismas reglas:
 * sede, profesional, candidato vigente, DX-128 y tope diario) con un token de
 * un solo uso que solo se guarda como hash y caduca al empezar el hueco (o
 * antes, `WAITLIST_LINK_OFFER_EXPIRY_LEAD_MINUTES`). Por email sale por el
 * outbox (DX-088); por WhatsApp el enlace vuelve al panel para `wa.me`.
 * Con menos de 20 minutos para el hueco no se envía.
 */
@Injectable()
export class CreateLinkOfferUseCase {
  constructor(
    private readonly createOffer: CreateWaitlistOfferUseCase,
    @Inject(OPENING_CANDIDATES_REPOSITORY)
    private readonly repo: OpeningCandidatesRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(STAFF_REPOSITORY)
    private readonly staff: StaffRepository,
    @Inject(SLOT_OFFER_REPOSITORY)
    private readonly slotOffers: SlotOfferRepository,
    @Inject(SLOT_OFFER_EMAIL_SENDER)
    private readonly email: SlotOfferEmailSender,
    private readonly audit: RecordAuditEventUseCase,
    @Inject(LINK_OFFER_CONFIG)
    private readonly config: LinkOfferConfig,
    @Inject(OPENING_CLOCK)
    private readonly clock: OpeningClock,
  ) {}

  async execute(
    input: Omit<CreateWaitlistOfferInput, 'channel' | 'outcome' | 'link'> & {
      channel: LinkChannel;
    },
    link: PublicLinkBase,
    ctx: AuditRequestContext,
  ): Promise<LinkOfferView> {
    const now = this.clock();
    const expiresAt = linkOfferExpiresAt(
      input.slotStart,
      this.config.expiryLeadMinutes,
    );
    // El enlace tiene que vivir al menos los mismos 20 minutos.
    if (!linkOfferWindowOpen(expiresAt, now)) {
      throw new ConflictException(LINK_OFFER_TOO_LATE_MESSAGE);
    }
    // Por email, los topes del outbox ANTES de crear nada (DX-088).
    const patient = await this.repo.patientContact(input.patientId);
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    if (input.channel === 'LINK_EMAIL') {
      const block = emailOfferBlock(patient);
      if (block === 'NO_EMAIL') {
        throw new ConflictException(OFFER_EMAIL_MISSING_MESSAGE);
      }
      if (block) throw new ConflictException(OFFER_EMAIL_BLOCKED_MESSAGE);
      await this.email.assertCanSend(patient.email!.trim());
    }

    const token = generateSlotOfferToken();
    const created = await this.createOffer.execute(
      { ...input, link: { tokenHash: hashSlotOfferToken(token), expiresAt } },
      ctx,
    );
    const url = buildSlotOfferUrl(link.protocol, link.host, token);
    const location = await this.locations.findById(created.locationId);
    if (!location) throw new NotFoundException('Sede no encontrada');

    if (input.channel === 'LINK_EMAIL') {
      const timeZone = requireLocationTimeZone(location);
      const format = requireLocationFormat(location);
      const [provider, clinic] = await Promise.all([
        this.staff.findById(created.providerId),
        this.slotOffers.findClinicBranding(),
      ]);
      try {
        await this.email.send({
          to: patient.email!.trim(),
          referenceId: created.id,
          vars: {
            patientFirstName: firstNameOnly(patient.firstName),
            clinicName: clinic?.name ?? location.name,
            slotLabel: format.longDateTime(created.slotStart, timeZone),
            locationName: location.name,
            providerName: provider?.fullName ?? null,
            url,
            expiresAtLabel: format.longDateTime(expiresAt, timeZone),
          },
        });
      } catch {
        // Sin email no hay enlace que aceptar: la oferta no puede quedar
        // PENDING («Oferta enviada») sin haberse enviado. Queda sin efecto
        // (EXPIRED, anotada por quien la envió y auditada) y se avisa.
        await this.markUndelivered(created.id, created.patientId, ctx);
        throw new ServiceUnavailableException(LINK_OFFER_EMAIL_FAILED_MESSAGE);
      }
      return { ...created, url: null, whatsappPhone: null };
    }
    const wa = whatsappOfferPhone(
      patient,
      phoneRegionOrNull(location.defaultPhoneRegion),
    );
    return { ...created, url, whatsappPhone: wa.phone };
  }

  private async markUndelivered(
    offerId: string,
    patientId: string,
    ctx: AuditRequestContext,
  ): Promise<void> {
    const updated = await this.repo.recordOutcome(
      offerId,
      'EXPIRED',
      ctx.actor.userId,
    );
    if (!updated) return;
    await this.audit.record({
      tenantId: ctx.tenantId,
      locationId: updated.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'UPDATE',
      resourceType: 'WAITLIST_OFFER',
      resourceId: offerId,
      patient: { kind: 'patient', id: patientId },
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: 'OFFER_LINK_EMAIL_FAILED' },
    });
  }
}
