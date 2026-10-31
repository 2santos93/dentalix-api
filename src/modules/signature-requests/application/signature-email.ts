import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import type {
  SignatureCodeEmailVars,
  SignatureRequestEmailVars,
} from '../../notifications/email/domain/email-message';
import { EmailQuotaExceededError } from '../../notifications/email/domain/email-quota-exceeded.error';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';

export const SIGNATURE_EMAIL_SENDER = Symbol('SIGNATURE_EMAIL_SENDER');

/**
 * Emails de la firma a distancia (DX-243) por el outbox (DX-088): el del
 * enlace, al enviarla, y el del código, cuando el paciente lo pide. El texto
 * de los dos va sin nada clínico (ver las plantillas).
 */
export interface SignatureEmailSender {
  /** Topes del outbox por destinatario y clínica: pasarlos es un 429 en español. */
  assertCanSend(to: string): Promise<void>;
  sendLink(input: {
    to: string;
    referenceId: string;
    vars: SignatureRequestEmailVars;
  }): Promise<void>;
  sendCode(input: {
    to: string;
    referenceId: string;
    vars: SignatureCodeEmailVars;
  }): Promise<void>;
  /** Cancela el email del enlace aún pendiente (al anular la solicitud). */
  cancelPendingLink(referenceId: string): Promise<void>;
}

function tenantIdOf(tenantContext: TenantContextService): string {
  const tenantId = tenantContext.getTenantId();
  if (!tenantId) throw new Error('No tenant in context');
  return tenantId;
}

/** Adaptador del outbox de email, como el de las indicaciones (DX-222). */
@Injectable()
export class OutboxSignatureEmailSender implements SignatureEmailSender {
  constructor(
    private readonly outbox: EmailOutbox,
    private readonly tenantContext: TenantContextService,
  ) {}

  async assertCanSend(to: string): Promise<void> {
    try {
      await this.outbox.assertWithinQuota(tenantIdOf(this.tenantContext), to);
    } catch (err) {
      if (err instanceof EmailQuotaExceededError) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            error: 'Too Many Requests',
            message: err.message,
            retryAfterSeconds: err.retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw err;
    }
  }

  async sendLink(input: {
    to: string;
    referenceId: string;
    vars: SignatureRequestEmailVars;
  }): Promise<void> {
    await this.outbox.enqueue({
      tenantId: tenantIdOf(this.tenantContext),
      to: input.to,
      template: 'signature-request',
      vars: input.vars,
      referenceId: input.referenceId,
    });
  }

  async sendCode(input: {
    to: string;
    referenceId: string;
    vars: SignatureCodeEmailVars;
  }): Promise<void> {
    await this.outbox.enqueue({
      tenantId: tenantIdOf(this.tenantContext),
      to: input.to,
      template: 'signature-code',
      vars: input.vars,
      referenceId: input.referenceId,
    });
  }

  async cancelPendingLink(referenceId: string): Promise<void> {
    await this.outbox.supersedePending(
      tenantIdOf(this.tenantContext),
      referenceId,
      'signature-request',
    );
  }
}
