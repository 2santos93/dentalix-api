import { Injectable } from '@nestjs/common';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import type { RegistrationNotifier } from '../domain/ports/registration-notifier.port';

/** Adaptador de los emails del registro sobre el email transaccional (DX-088). */
@Injectable()
export class EmailRegistrationNotifier implements RegistrationNotifier {
  constructor(private readonly outbox: EmailOutbox) {}

  async sendVerification(input: {
    to: string;
    userName: string;
    verifyUrl: string;
    expiresInHours: number;
  }): Promise<void> {
    await this.outbox.enqueue({
      to: input.to,
      template: 'email-verify',
      locale: 'es',
      vars: {
        userName: input.userName,
        verifyUrl: input.verifyUrl,
        expiresInHours: input.expiresInHours,
      },
    });
  }

  async sendExistingAccountNotice(input: {
    to: string;
    userName: string;
    loginUrl: string;
  }): Promise<void> {
    await this.outbox.enqueue({
      to: input.to,
      template: 'registration-notice',
      locale: 'es',
      vars: { userName: input.userName, loginUrl: input.loginUrl },
    });
  }
}
