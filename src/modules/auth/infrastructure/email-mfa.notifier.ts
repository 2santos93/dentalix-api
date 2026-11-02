import { Injectable, Logger } from '@nestjs/common';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import type { MfaNotifier } from '../domain/ports/mfa-notifier.port';

/**
 * Adaptador de los correos de la verificación en dos pasos (DX-021-bis). Con
 * clínica, firma ella y no pasa por los topes anti-abuso (un aviso de
 * seguridad no se calla); sin ella es un email de plataforma, con su tope.
 */
@Injectable()
export class EmailMfaNotifier implements MfaNotifier {
  private readonly logger = new Logger('UserMfa');

  constructor(private readonly outbox: EmailOutbox) {}

  async notice(input: Parameters<MfaNotifier['notice']>[0]): Promise<void> {
    const message = {
      to: input.to,
      template: 'mfa-notice' as const,
      locale: 'es' as const,
      vars: {
        kind: input.kind,
        recoveryCodesRemaining: input.recoveryCodesRemaining,
      },
    };
    try {
      if (input.tenantId) {
        await this.outbox.enqueue({ ...message, tenantId: input.tenantId });
      } else {
        await this.outbox.enqueuePlatform(message);
      }
    } catch (err) {
      // Solo el tipo de error: el de Prisma puede llevar el email.
      this.logger.warn({
        event: 'user_mfa.notice_failed',
        kind: input.kind,
        error: err instanceof Error ? err.constructor.name : typeof err,
      });
    }
  }

  async sendEnrollmentCode(
    input: Parameters<MfaNotifier['sendEnrollmentCode']>[0],
  ): Promise<void> {
    await this.outbox.enqueuePlatform({
      to: input.to,
      template: 'mfa-enrollment-code',
      locale: 'es',
      vars: { code: input.code, expiresInMinutes: input.expiresInMinutes },
    });
  }
}
