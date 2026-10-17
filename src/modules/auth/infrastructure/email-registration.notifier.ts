import { Injectable } from '@nestjs/common';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import type { RegistrationNotifier } from '../domain/ports/registration-notifier.port';

/**
 * Adaptador de los emails del registro sobre el email transaccional (DX-088):
 * emails de plataforma con el tope por destinatario de DX-144.
 */
@Injectable()
export class EmailRegistrationNotifier implements RegistrationNotifier {
  constructor(private readonly outbox: EmailOutbox) {}

  get recipientCooldownSeconds(): number {
    return this.outbox.platformRecipientCooldownSeconds;
  }

  withinRecipientQuota(to: string): Promise<boolean> {
    return this.outbox.withinPlatformRecipientQuota(to);
  }

  async sendVerification(input: {
    to: string;
    verifyUrl: string;
    expiresInHours: number;
  }): Promise<boolean> {
    const queued = await this.outbox.enqueuePlatform({
      to: input.to,
      template: 'email-verify',
      locale: 'es',
      vars: {
        verifyUrl: input.verifyUrl,
        expiresInHours: input.expiresInHours,
      },
    });
    return queued !== null;
  }

  async sendExistingAccountNotice(input: {
    to: string;
    userName: string;
    loginUrl: string;
  }): Promise<boolean> {
    const queued = await this.outbox.enqueuePlatform({
      to: input.to,
      template: 'registration-notice',
      locale: 'es',
      vars: { userName: input.userName, loginUrl: input.loginUrl },
    });
    return queued !== null;
  }
}
