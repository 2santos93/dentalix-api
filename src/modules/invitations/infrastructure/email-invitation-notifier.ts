import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { EmailQuotaExceededError } from '../../notifications/email/domain/email-quota-exceeded.error';
import { ClinicRole, Prisma } from '@prisma/client';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import { describeDeliveryError } from '../../notifications/email/application/retry-policy';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  InvitationNotifier,
  InvitationEmailTarget,
  PreparedInvitationEmail,
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

/** El 429 de los topes del email (DX-088), con su espera. */
function tooManyRequests(err: EmailQuotaExceededError): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      message: err.message,
      retryAfterSeconds: err.retryAfterSeconds,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/** Adaptador del puerto de avisos de invitación sobre el email transaccional. */
@Injectable()
export class EmailInvitationNotifier implements InvitationNotifier {
  private readonly logger = new Logger('Invitations');

  constructor(
    private readonly outbox: EmailOutbox,
    private readonly tenantContext: TenantContextService,
  ) {}

  async prepareInvitation(input: {
    invitation: InvitationEmailTarget;
    token: string;
    linkBase: string;
  }): Promise<PreparedInvitationEmail | null> {
    const { invitation } = input;
    let mail;
    try {
      mail = await this.outbox.prepareInTx(this.emailOf(input));
    } catch (err) {
      // Sin email la invitación se crea o se reemite igual y el ADMIN tiene
      // el enlace para compartirlo o reenviarla (nunca un 500).
      this.logger.warn({
        event: 'invitation.email_not_enqueued',
        invitationId: invitation.id,
        error: describeDeliveryError(err),
      });
      return null;
    }
    return {
      insert: async (tx) => {
        try {
          await mail.insert(tx);
        } catch (err) {
          if (err instanceof EmailQuotaExceededError) {
            throw tooManyRequests(err);
          }
          throw err;
        }
      },
      kick: () => mail.kick(),
    };
  }

  async cancelPendingInTx(
    tx: Prisma.TransactionClient,
    invitationIds: string[],
  ): Promise<void> {
    for (const id of invitationIds) {
      await this.outbox.supersedePendingInTx(tx, id, 'invitation');
    }
  }

  private emailOf(input: {
    invitation: InvitationEmailTarget;
    token: string;
    linkBase: string;
  }) {
    const { invitation } = input;
    return {
      tenantId: invitation.tenantId,
      to: invitation.email,
      template: 'invitation' as const,
      referenceId: invitation.id,
      locale: 'es' as const,
      enforceQuota: true,
      vars: {
        inviteeName: invitation.fullName,
        roleLabel: ROLE_LABEL[invitation.role],
        acceptUrl: `${input.linkBase}${INVITATION_ACCEPT_PATH}/${input.token}`,
        expiresInDays: INVITATION_TTL_DAYS,
      },
    };
  }

  async assertCanSend(email: string): Promise<void> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) return;
    try {
      await this.outbox.assertWithinQuota(tenantId, email, 'invitation');
    } catch (err) {
      if (err instanceof EmailQuotaExceededError) throw tooManyRequests(err);
      throw err;
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
