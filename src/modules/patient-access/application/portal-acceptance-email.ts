import { Injectable } from '@nestjs/common';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import type { SignatureBudgetAcceptedEmailVars } from '../../notifications/email/domain/email-message';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';

export const PORTAL_ACCEPTANCE_EMAIL = Symbol('PORTAL_ACCEPTANCE_EMAIL');

/**
 * DX-101-bis: el email de confirmación de la aceptación desde el portal, la
 * MISMA plantilla que la del enlace de firma (DX-415) con su variante de
 * portal: sin importes, procedimientos ni enlaces.
 */
export interface PortalAcceptanceEmail {
  sendBudgetAccepted(input: {
    to: string;
    referenceId: string;
    vars: SignatureBudgetAcceptedEmailVars;
  }): Promise<void>;
}

/** Adaptador del outbox de email (DX-088), como el de la firma a distancia. */
@Injectable()
export class OutboxPortalAcceptanceEmail implements PortalAcceptanceEmail {
  constructor(
    private readonly outbox: EmailOutbox,
    private readonly tenantContext: TenantContextService,
  ) {}

  async sendBudgetAccepted(input: {
    to: string;
    referenceId: string;
    vars: SignatureBudgetAcceptedEmailVars;
  }): Promise<void> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    await this.outbox.enqueue({
      tenantId,
      to: input.to,
      template: 'signature-budget-accepted',
      vars: input.vars,
      referenceId: input.referenceId,
    });
  }
}
