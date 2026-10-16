import { Logger } from '@nestjs/common';
import { OutgoingEmail } from '../../domain/email-message';
import { Mailer } from '../../domain/ports/mailer.port';
import { maskEmail } from '../../../../../shared/privacy/mask-email';

/**
 * Adaptador de desarrollo y test: no envía nada, deja UNA línea de log
 * estructurada con el destinatario ENMASCARADO y el tamaño del mensaje. Ni el
 * correo en claro ni el cuerpo (lleva el enlace con el token) llegan al log.
 */
export class ConsoleMailer implements Mailer {
  private readonly logger = new Logger('Email');

  send(message: OutgoingEmail): Promise<void> {
    this.logger.log({
      event: 'email.console',
      to: maskEmail(message.to),
      subjectLength: message.subject.length,
      htmlBytes: Buffer.byteLength(message.html, 'utf8'),
      textBytes: Buffer.byteLength(message.text, 'utf8'),
    });
    return Promise.resolve();
  }
}
