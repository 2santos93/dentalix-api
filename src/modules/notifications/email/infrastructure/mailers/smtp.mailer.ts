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
    const transporter = createTransport({ url: smtpUrl, ...SMTP_TIMEOUTS });
    return new SmtpMailer(from, transporter);
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
