import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import { ipBucket } from '../domain/login-lockout';
import {
  MFA_ENROLLMENT_CODE_INTERVAL_SECONDS,
  type MfaNotifier,
} from '../domain/ports/mfa-notifier.port';

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
  ): Promise<boolean> {
    const queued = await this.outbox.enqueuePlatformSecurity(
      {
        to: input.to,
        template: 'mfa-enrollment-code',
        locale: 'es',
        referenceId: clientReference(input.userId, input.ip),
        vars: {
          code: input.code,
          ref: input.ref,
          expiresInMinutes: input.expiresInMinutes,
        },
      },
      MFA_ENROLLMENT_CODE_INTERVAL_SECONDS,
    );
    return queued !== null;
  }
}

/** UUID estable de cuenta + cliente: el plazo entre correos va por pareja. */
function clientReference(userId: string, ip: string | null): string {
  const hex = createHash('sha256')
    .update(`${userId}:${ipBucket(ip ?? 'unknown')}`)
    .digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
