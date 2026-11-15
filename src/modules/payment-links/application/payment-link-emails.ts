import { Injectable } from '@nestjs/common';
import {
  EmailOutbox,
  type PreparedEmail,
} from '../../notifications/email/application/email-outbox.service';
import { withEmailQuotaAs429 } from '../../notifications/email/application/email-quota-http';
import type {
  PaymentLinkEmailVars,
  PaymentReportRejectedEmailVars,
} from '../../notifications/email/domain/email-message';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';

export const PAYMENT_LINK_EMAILS = Symbol('PAYMENT_LINK_EMAILS');

/** Los emails del enlace de pago (DX-569) por el outbox de DX-088. */
export interface PaymentLinkEmails {
  /** Topes del outbox (DX-088): pasarlos es un 429 en español. */
  assertCanSend(to: string): Promise<void>;
  /**
   * DX-463: el email del enlace se encola DENTRO de la transacción que lo
   * crea: `insert(tx)` dentro, `kick()` tras el COMMIT. El tope se cuenta al
   * insertar, bajo candado (DX-149-ter): si no cabe, 429 y no queda enlace.
   */
  prepareLink(input: {
    to: string;
    linkId: string;
    vars: PaymentLinkEmailVars;
  }): Promise<PreparedEmail>;
  /** El aviso del rechazo (sin el motivo interno). */
  sendRejected(input: {
    to: string;
    reportId: string;
    vars: PaymentReportRejectedEmailVars;
  }): Promise<void>;
}

function tenantIdOf(tenantContext: TenantContextService): string {
  const tenantId = tenantContext.getTenantId();
  if (!tenantId) throw new Error('No tenant in context');
  return tenantId;
}

@Injectable()
export class OutboxPaymentLinkEmails implements PaymentLinkEmails {
  constructor(
    private readonly outbox: EmailOutbox,
    private readonly tenantContext: TenantContextService,
  ) {}

  assertCanSend(to: string): Promise<void> {
    return withEmailQuotaAs429(() =>
      this.outbox.assertWithinQuota(
        tenantIdOf(this.tenantContext),
        to,
        'payment-link',
      ),
    );
  }

  async prepareLink(input: {
    to: string;
    linkId: string;
    vars: PaymentLinkEmailVars;
  }): Promise<PreparedEmail> {
    const mail = await this.outbox.prepareInTx({
      tenantId: tenantIdOf(this.tenantContext),
      to: input.to,
      template: 'payment-link',
      vars: input.vars,
      referenceId: input.linkId,
      enforceQuota: true,
    });
    return {
      insert: (tx) => withEmailQuotaAs429(() => mail.insert(tx)),
      kick: () => mail.kick(),
    };
  }

  async sendRejected(input: {
    to: string;
    reportId: string;
    vars: PaymentReportRejectedEmailVars;
  }): Promise<void> {
    await withEmailQuotaAs429(() =>
      this.outbox.enqueue({
        tenantId: tenantIdOf(this.tenantContext),
        to: input.to,
        template: 'payment-report-rejected',
        vars: input.vars,
        referenceId: input.reportId,
        enforceQuota: true,
      }),
    );
  }
}
