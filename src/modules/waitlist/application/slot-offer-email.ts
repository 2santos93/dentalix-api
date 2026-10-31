import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import type { SlotOfferEmailVars } from '../../notifications/email/domain/email-message';
import { EmailQuotaExceededError } from '../../notifications/email/domain/email-quota-exceeded.error';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';

export const SLOT_OFFER_EMAIL_SENDER = Symbol('SLOT_OFFER_EMAIL_SENDER');

/** DX-435: el email con el enlace de la oferta, por el outbox (DX-088). */
export interface SlotOfferEmailSender {
  /** Topes del outbox por destinatario y clínica: pasarlos es un 429 en español. */
  assertCanSend(to: string): Promise<void>;
  send(input: {
    to: string;
    referenceId: string;
    vars: SlotOfferEmailVars;
  }): Promise<void>;
}

function tenantIdOf(tenantContext: TenantContextService): string {
  const tenantId = tenantContext.getTenantId();
  if (!tenantId) throw new Error('No tenant in context');
  return tenantId;
}

/** Adaptador del outbox, como el de la firma a distancia (DX-243). */
@Injectable()
export class OutboxSlotOfferEmailSender implements SlotOfferEmailSender {
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

  async send(input: {
    to: string;
    referenceId: string;
    vars: SlotOfferEmailVars;
  }): Promise<void> {
    await this.outbox.enqueue({
      tenantId: tenantIdOf(this.tenantContext),
      to: input.to,
      template: 'slot-offer',
      vars: input.vars,
      referenceId: input.referenceId,
    });
  }
}
