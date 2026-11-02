import { Injectable, Logger } from '@nestjs/common';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import type { MfaNotifier } from '../domain/ports/mfa-notifier.port';

/**
 * Un código vale al menos estos segundos (`MfaChallengeService`): con uno cada
 * tanto, siempre hay uno vigente en el buzón.
 */
const ENROLLMENT_CODE_INTERVAL_SECONDS = 600;

/**
 * Adaptador de los correos de la verificación en dos pasos (DX-021-bis). Un
 * aviso de seguridad no se calla: no pasan por los topes anti-abuso, ni con
 * clínica (firma ella) ni sin ella (firma Dentalix).
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
        await this.outbox.enqueuePlatformSecurity(message, 0);
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
    // `null` = ya salió uno hace menos de 10 min, y su código sigue vigente.
    await this.outbox.enqueuePlatformSecurity(
      {
        to: input.to,
        template: 'mfa-enrollment-code',
        locale: 'es',
        vars: { code: input.code, expiresInMinutes: input.expiresInMinutes },
      },
      ENROLLMENT_CODE_INTERVAL_SECONDS,
    );
  }
}
