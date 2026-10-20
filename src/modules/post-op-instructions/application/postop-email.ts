import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import type { PostOpInstructionsEmailVars } from '../../notifications/email/domain/email-message';
import { EmailQuotaExceededError } from '../../notifications/email/domain/email-quota-exceeded.error';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';

export interface PostOpEmailSendInput {
  to: string;
  vars: PostOpInstructionsEmailVars;
  /** La entrega que lo origina (estado de envío en el outbox). */
  referenceId: string;
}

export const POSTOP_EMAIL_SENDER = Symbol('POSTOP_EMAIL_SENDER');

/**
 * Envío por email de las indicaciones (DX-222). En dos pasos para que el tope
 * se mire ANTES de registrar la entrega y el email lleve su id después.
 */
export interface PostOpEmailSender {
  /** Topes del outbox (DX-088): pasarlos es un 429 en español. */
  assertCanSend(to: string): Promise<void>;
  send(input: PostOpEmailSendInput): Promise<void>;
}

function tenantIdOf(tenantContext: TenantContextService): string {
  const tenantId = tenantContext.getTenantId();
  if (!tenantId) throw new Error('No tenant in context');
  return tenantId;
}

/**
 * Adaptador del outbox de email: encola el mensaje cifrado y vuelve; el
 * despachador lo entrega. Igual que el recibo de caja (DX-136).
 */
@Injectable()
export class OutboxPostOpEmailSender implements PostOpEmailSender {
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

  async send(input: PostOpEmailSendInput): Promise<void> {
    await this.outbox.enqueue({
      tenantId: tenantIdOf(this.tenantContext),
      to: input.to,
      template: 'post-op-instructions',
      vars: input.vars,
      referenceId: input.referenceId,
    });
  }
}
