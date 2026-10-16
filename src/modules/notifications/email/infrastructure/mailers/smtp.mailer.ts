import { createTransport } from 'nodemailer';
import { OutgoingEmail } from '../../domain/email-message';
import { Mailer } from '../../domain/ports/mailer.port';

/**
 * Timeouts del socket SMTP: muy por debajo del arriendo de 5 min del
 * despachador, para que un proveedor colgado no provoque un doble envío.
 */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 60_000,
} as const;

/**
 * Opciones del transporte a partir de `SMTP_URL` (revisión D2). Se arman a
 * mano en vez de pasar `{ url }` a nodemailer porque nodemailer lee opciones
 * de la query de la URL y les da PRIORIDAD (`?ignoreTLS=true`,
 * `?tls.rejectUnauthorized=false`): aquí la query se ignora siempre (y en
 * producción la validación del arranque la rechaza). TLS obligatorio:
 * smtps:// cifra desde el inicio y smtp:// exige STARTTLS (`requireTLS`), así
 * que un intermediario no puede degradar la conexión a texto plano; TLS ≥ 1.2
 * y certificado verificado.
 */
export function smtpTransportOptions(smtpUrl: string) {
  const url = new URL(smtpUrl);
  const secure = url.protocol === 'smtps:';
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    requireTLS: true,
    tls: { minVersion: 'TLSv1.2' as const, rejectUnauthorized: true },
    ...(url.username
      ? {
          auth: {
            user: decodeURIComponent(url.username),
            pass: decodeURIComponent(url.password),
          },
        }
      : {}),
    ...SMTP_TIMEOUTS,
  };
}

/** Lo que el adaptador usa del transporte de nodemailer (sustituible en tests). */
export interface SmtpTransport {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    disableFileAccess: boolean;
    disableUrlAccess: boolean;
  }): Promise<unknown>;
  close(): void;
}

/**
 * Adaptador SMTP (nodemailer). Cualquier proveedor con SMTP sirve (SES,
 * Resend, Postmark, Mailgun…): se configura con `SMTP_URL` y `MAIL_FROM`.
 * Sin acceso a ficheros ni URLs desde el mensaje: solo viajan el texto y el
 * HTML que renderizó la API.
 */
export class SmtpMailer implements Mailer {
  constructor(
    private readonly from: string,
    private readonly transport: SmtpTransport,
  ) {}

  static fromUrl(smtpUrl: string, from: string): SmtpMailer {
    return new SmtpMailer(from, createTransport(smtpTransportOptions(smtpUrl)));
  }

  async send(message: OutgoingEmail): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  close(): void {
    this.transport.close();
  }
}
