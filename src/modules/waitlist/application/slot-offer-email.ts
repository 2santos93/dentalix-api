import { Injectable } from '@nestjs/common';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import type { SlotOfferEmailVars } from '../../notifications/email/domain/email-message';
import { withEmailQuotaAs429 } from '../../notifications/email/application/email-quota-http';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';

export const SLOT_OFFER_EMAIL_SENDER = Symbol('SLOT_OFFER_EMAIL_SENDER');

/** DX-435: el email con el enlace de la oferta, por el outbox (DX-088). */
export interface SlotOfferEmailSender {
  /** Topes del outbox por destinatario y clínica: pasarlos es un 429 en español. */
  assertCanSend(to: string): Promise<void>;
  /** Encola con los topes bajo candado (DX-149-ter): pasarlos, el mismo 429. */
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

  assertCanSend(to: string): Promise<void> {
    return withEmailQuotaAs429(() =>
      this.outbox.assertWithinQuota(
        tenantIdOf(this.tenantContext),
        to,
        'slot-offer',
      ),
    );
  }

  /**
   * DX-149-ter: con `enforceQuota` (candado de la clínica y del
   * destinatario). Pasar el tope es el mismo 429 que el aviso temprano.
   */
  async send(input: {
    to: string;
    referenceId: string;
    vars: SlotOfferEmailVars;
  }): Promise<void> {
    await withEmailQuotaAs429(() =>
      this.outbox.enqueue({
        tenantId: tenantIdOf(this.tenantContext),
        to: input.to,
        template: 'slot-offer',
        vars: input.vars,
        referenceId: input.referenceId,
        enforceQuota: true,
      }),
    );
  }
}
