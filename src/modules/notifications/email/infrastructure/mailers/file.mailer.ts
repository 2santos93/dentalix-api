import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OutgoingEmail } from '../../domain/email-message';
import { Mailer } from '../../domain/ports/mailer.port';
import { maskEmail } from '../../../../../shared/privacy/mask-email';

/**
 * Adaptador de DESARROLLO y e2e (MAIL_TRANSPORT=file, DX-010): deja cada email
 * completo como `<ms>-<uuid>.json` (permisos 0600) en `dir`, para abrir sus
 * enlaces (restablecer contraseña, invitación) sin un servidor SMTP. Lleva
 * tokens en claro: la validación del arranque lo prohíbe en producción. El
 * log solo dice el destinatario enmascarado, como ConsoleMailer.
 */
export class FileMailer implements Mailer {
  private readonly logger = new Logger('Email');

  constructor(private readonly dir: string) {}

  async send(message: OutgoingEmail): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = `${Date.now()}-${randomUUID()}.json`;
    await writeFile(
      join(this.dir, file),
      JSON.stringify({
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      { mode: 0o600 },
    );
    this.logger.log({ event: 'email.file', to: maskEmail(message.to), file });
  }
}
