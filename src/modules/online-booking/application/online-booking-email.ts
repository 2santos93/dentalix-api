import { Inject, Injectable, Logger } from '@nestjs/common';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import type { OnlineBookingReceivedEmailVars } from '../../notifications/email/domain/email-message';
import {
  LOCATION_REPOSITORY,
  type LocationRepository,
} from '../../locations/domain/ports/location-repository.port';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import { TenantLinkBaseService } from '../../../shared/tenancy/tenant-link-base.service';
import { CreateConfirmationLinkUseCase } from '../../appointment-confirmations/application/use-cases/create-confirmation-link.use-case';
import {
  ONLINE_BOOKING_REPOSITORY,
  type OnlineBookingRepository,
} from '../domain/ports/online-booking-repository.port';
import { BOOKING_CODE_TTL_MINUTES } from '../domain/booking-security';

/** Ruta pública del enlace de confirmación de DX-005 en la web. */
export const CONFIRMATION_PUBLIC_PATH = '/confirmar';

function firstNameOnly(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

/**
 * DX-016: correos de la reserva online por el outbox (DX-088). Un fallo al
 * encolar no deshace la reserva ni cambia la respuesta (la del código no
 * puede delatar si la ficha existe): queda en el log, sin datos personales.
 */
@Injectable()
export class OnlineBookingEmail {
  private readonly logger = new Logger(OnlineBookingEmail.name);

  constructor(
    private readonly outbox: EmailOutbox,
    private readonly linkBase: TenantLinkBaseService,
    private readonly confirmationLinks: CreateConfirmationLinkUseCase,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(ONLINE_BOOKING_REPOSITORY)
    private readonly repo: OnlineBookingRepository,
  ) {}

  async sendCode(input: {
    tenantId: string;
    to: string;
    referenceId: string;
    firstName: string;
    clinicName: string;
    code: string;
  }): Promise<void> {
    try {
      await this.outbox.enqueue({
        tenantId: input.tenantId,
        to: input.to,
        template: 'online-booking-code',
        referenceId: input.referenceId,
        vars: {
          recipientFirstName: firstNameOnly(input.firstName),
          clinicName: input.clinicName,
          code: input.code,
          expiresInMinutes: BOOKING_CODE_TTL_MINUTES,
        },
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo encolar el código de la reserva online ${input.referenceId}: ${(error as Error).name}`,
      );
    }
  }

  /**
   * Enlace de gestión (DX-005, `/confirmar/<token>`) de una cita ya creada.
   * `null` si no se pudo emitir (la cita queda igual).
   */
  async manageUrl(
    tenantId: string,
    appointmentId: string,
    requestHost: string | undefined,
  ): Promise<string | null> {
    try {
      const link = await this.confirmationLinks.execute({
        appointmentId,
        automatic: true,
      });
      const base = await this.linkBase.forTenant(tenantId, requestHost);
      return base ? `${base}${CONFIRMATION_PUBLIC_PATH}/${link.token}` : null;
    } catch (error) {
      this.logger.warn(
        `No se pudo emitir el enlace de la cita online ${appointmentId}: ${(error as Error).name}`,
      );
      return null;
    }
  }

  async sendReceived(input: {
    tenantId: string;
    patientId: string;
    referenceId: string;
    clinicName: string;
    state: OnlineBookingReceivedEmailVars['state'];
    start: Date;
    locationId: string;
    providerName: string | null;
    manageUrl: string | null;
  }): Promise<void> {
    try {
      const contact = await this.repo.patientContact(input.patientId);
      const to = contact?.email?.trim();
      if (!contact || !to) return;
      const location = await this.locations.findById(input.locationId);
      if (!location?.timeZone) return;
      const format = requireLocationFormat(location);
      await this.outbox.enqueue({
        tenantId: input.tenantId,
        to,
        template: 'online-booking-received',
        referenceId: input.referenceId,
        vars: {
          recipientFirstName: firstNameOnly(contact.firstName),
          clinicName: input.clinicName || location.name,
          state: input.state,
          slotLabel: format.longDateTime(input.start, location.timeZone),
          locationName: location.name,
          providerName: input.providerName,
          manageUrl: input.manageUrl,
        },
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo encolar el acuse de la reserva online ${input.referenceId}: ${(error as Error).name}`,
      );
    }
  }
}
