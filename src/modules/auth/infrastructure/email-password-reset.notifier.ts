import { Injectable } from '@nestjs/common';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import { EmailQuotaExceededError } from '../../notifications/email/domain/email-quota-exceeded.error';
import type {
  PasswordResetEmail,
  PasswordResetNotifier,
} from '../domain/ports/password-reset-notifier.port';

/** Adaptador del aviso de restablecimiento sobre el email transaccional. */
@Injectable()
export class EmailPasswordResetNotifier implements PasswordResetNotifier {
  constructor(private readonly outbox: EmailOutbox) {}

  async withinQuota(tenantId: string, to: string): Promise<boolean> {
    try {
      await this.outbox.assertWithinQuota(tenantId, to);
      return true;
    } catch (err) {
      if (err instanceof EmailQuotaExceededError) return false;
      throw err;
    }
  }

  async send(email: PasswordResetEmail): Promise<void> {
    // La referencia es el usuario: el email pendiente con el enlace anterior
    // (que ya no vale) no llega a salir.
    await this.outbox.supersedePending(
      email.tenantId,
      email.userId,
      'password-reset',
    );
    await this.outbox.enqueue({
      tenantId: email.tenantId,
      to: email.to,
      template: 'password-reset',
      referenceId: email.userId,
      locale: 'es',
      vars: {
        userName: email.userName,
        resetUrl: email.resetUrl,
        expiresInMinutes: email.expiresInMinutes,
      },
    });
  }
}
