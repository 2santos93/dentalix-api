import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailDispatcher } from './application/email-dispatcher.service';
import { EmailOutbox } from './application/email-outbox.service';
import { EMAIL_OUTBOX_REPOSITORY } from './domain/ports/email-outbox-repository.port';
import { MAILER } from './domain/ports/mailer.port';
import type { Mailer } from './domain/ports/mailer.port';
import { EmailPayloadCipher } from './infrastructure/email-payload-cipher';
import { loadMailConfig, MAIL_CONFIG } from './infrastructure/mail-config';
import type { MailConfig } from './infrastructure/mail-config';
import { ConsoleMailer } from './infrastructure/mailers/console.mailer';
import { SmtpMailer } from './infrastructure/mailers/smtp.mailer';
import { FileMailer } from './infrastructure/mailers/file.mailer';
import { PrismaEmailOutboxRepository } from './infrastructure/repositories/prisma-email-outbox.repository';

/**
 * Email transaccional (DX-088): puerto `Mailer` con adaptadores Console (dev y
 * test) y SMTP, plantillas en español y registro de envíos con despachador en
 * proceso. Los módulos que envían emails importan este módulo y usan
 * `EmailOutbox.enqueue(...)`.
 */
@Module({
  providers: [
    {
      provide: MAIL_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): MailConfig => {
        const mail = loadMailConfig((key) => config.get<string>(key));
        if (mail.ephemeralKey && config.get<string>('NODE_ENV') !== 'test') {
          new Logger('Email').warn({
            event: 'email.ephemeral_key',
            hint: 'Sin MAIL_ENCRYPTION_KEY: los emails pendientes no sobreviven a un reinicio.',
          });
        }
        return mail;
      },
    },
    {
      provide: MAILER,
      inject: [MAIL_CONFIG],
      useFactory: (config: MailConfig): Mailer => {
        if (config.transport === 'smtp' && config.smtpUrl) {
          return SmtpMailer.fromUrl(config.smtpUrl, config.from);
        }
        if (config.transport === 'file' && config.fileDir) {
          return new FileMailer(config.fileDir);
        }
        return new ConsoleMailer();
      },
    },
    {
      provide: EmailPayloadCipher,
      inject: [MAIL_CONFIG],
      useFactory: (config: MailConfig): EmailPayloadCipher =>
        new EmailPayloadCipher(config.encryptionKey),
    },
    { provide: EMAIL_OUTBOX_REPOSITORY, useClass: PrismaEmailOutboxRepository },
    EmailDispatcher,
    EmailOutbox,
  ],
  exports: [EmailOutbox, EmailDispatcher],
})
export class EmailModule {}
