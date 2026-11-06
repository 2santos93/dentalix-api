import { Injectable } from '@nestjs/common';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import { EmailQuotaExceededError } from '../../notifications/email/domain/email-quota-exceeded.error';
import { PasswordResetThrottledError } from '../domain/password-reset-throttled.error';
import type {
  PasswordResetEmail,
  PasswordResetNotifier,
  PreparedPasswordResetEmail,
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

  async prepare(
    email: PasswordResetEmail,
  ): Promise<PreparedPasswordResetEmail> {
    // DX-149-ter: el tope se vuelve a contar al insertar, bajo el candado del
    // destinatario SOLO (endpoint público: sin el de la clínica, ver
    // QuotaLockScope), en la transacción que emite el token.
    const mail = await this.outbox.prepareInTx({
      tenantId: email.tenantId,
      to: email.to,
      template: 'password-reset',
      referenceId: email.userId,
      locale: 'es',
      enforceQuota: 'recipient',
      vars: {
        userName: email.userName,
        resetUrl: email.resetUrl,
        expiresInMinutes: email.expiresInMinutes,
      },
    });
    return {
      insert: async (tx) => {
        // La referencia es el usuario: el email pendiente con el enlace
        // anterior (que deja de valer en esta misma transacción) no sale.
        await this.outbox.supersedePendingInTx(
          tx,
          email.userId,
          'password-reset',
        );
        try {
          await mail.insert(tx);
        } catch (err) {
          if (err instanceof EmailQuotaExceededError) {
            throw new PasswordResetThrottledError('QUOTA');
          }
          throw err;
        }
      },
      kick: () => mail.kick(),
    };
  }
}
