import type { Mailer } from '../../src/modules/notifications/email/domain/ports/mailer.port';
import type { OutgoingEmail } from '../../src/modules/notifications/email/domain/email-message';

/**
 * Transporte de email de test: guarda lo que el despachador entrega. Desde
 * DX-029 el token de la invitación solo viaja en el email (el ADMIN ya no lo
 * recibe), así que los e2e lo sacan de aquí, como lo haría la persona
 * invitada desde su buzón.
 */
export class CapturingMailer implements Mailer {
  readonly sent: OutgoingEmail[] = [];

  send(message: OutgoingEmail): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  /** Último email a `to` cuyo texto cumple `pattern` (espera al despachador). */
  async waitFor(
    to: string,
    pattern: RegExp,
    timeoutMs = 5000,
  ): Promise<RegExpExecArray> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = this.sent.length - 1; i >= 0; i--) {
        const email = this.sent[i];
        const match = email.to === to ? pattern.exec(email.text) : null;
        if (match) return match;
      }
      if (Date.now() > deadline) {
        throw new Error(`No llegó a ${to} un email que cumpla ${pattern}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Token del enlace `/invitacion/<token>` del último email de invitación a `to`. */
  async invitationToken(to: string): Promise<string> {
    const match = await this.waitFor(to, /\/invitacion\/([0-9a-f]{64})/);
    return match[1];
  }

  /** Vacía lo recibido (para no confundir un enlace viejo con uno nuevo). */
  clear(): void {
    this.sent.length = 0;
  }
}
