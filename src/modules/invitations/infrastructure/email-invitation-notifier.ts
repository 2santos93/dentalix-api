import { Injectable, Logger } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import { describeDeliveryError } from '../../notifications/email/application/retry-policy';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { ClinicInvitation } from '../domain/entities/clinic-invitation.entity';
import {
  InvitationEmailDelivery,
  InvitationNotifier,
} from '../domain/ports/invitation-notifier.port';
import { INVITATION_TTL_DAYS } from '../application/use-cases/create-invitation.use-case';

/** Ruta pública de la web (src/app/(auth)/invitacion/[token]). */
export const INVITATION_ACCEPT_PATH = '/invitacion';

const ROLE_LABEL: Record<ClinicRole, string> = {
  ADMIN: 'Administrador/a',
  DENTIST: 'Odontólogo/a',
  ASSISTANT: 'Asistente',
  RECEPTION: 'Recepción',
};

/** Adaptador del puerto de avisos de invitación sobre el email transaccional. */
@Injectable()
export class EmailInvitationNotifier implements InvitationNotifier {
  private readonly logger = new Logger('Invitations');

  constructor(
    private readonly outbox: EmailOutbox,
    private readonly tenantContext: TenantContextService,
  ) {}

  async sendInvitation(input: {
    invitation: ClinicInvitation;
    token: string;
    linkBase: string;
  }): Promise<InvitationEmailDelivery | null> {
    const { invitation } = input;
    try {
      await this.outbox.supersedePending(
        invitation.tenantId,
        invitation.id,
        'invitation',
      );
      await this.outbox.enqueue({
        tenantId: invitation.tenantId,
        to: invitation.email,
        template: 'invitation',
        referenceId: invitation.id,
        locale: 'es',
        vars: {
          inviteeName: invitation.fullName,
          roleLabel: ROLE_LABEL[invitation.role],
          acceptUrl: `${input.linkBase}${INVITATION_ACCEPT_PATH}/${input.token}`,
          expiresInDays: INVITATION_TTL_DAYS,
        },
      });
      return 'PENDING';
    } catch (err) {
      // La invitación ya está creada y el ADMIN tiene el enlace: no se
      // convierte en un 500 (puede reenviarla).
      this.logger.warn({
        event: 'invitation.email_not_enqueued',
        invitationId: invitation.id,
        error: describeDeliveryError(err),
      });
      return null;
    }
  }

  async cancelPending(invitationId: string): Promise<void> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) return;
    try {
      await this.outbox.supersedePending(tenantId, invitationId, 'invitation');
    } catch (err) {
      this.logger.warn({
        event: 'invitation.email_not_cancelled',
        invitationId,
        error: describeDeliveryError(err),
      });
    }
  }
}
