import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import { withEmailQuotaAs429 } from '../../notifications/email/application/email-quota-http';
import type {
  SignatureBudgetAcceptedEmailVars,
  SignatureCodeEmailVars,
  SignatureRequestEmailVars,
} from '../../notifications/email/domain/email-message';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';

export const SIGNATURE_EMAIL_SENDER = Symbol('SIGNATURE_EMAIL_SENDER');

/**
 * DX-149-ter: el email del enlace, listo para encolarlo DENTRO de la
 * transacción que guarda la solicitud (DX-463): `insert` dentro, `kick()`
 * después del COMMIT.
 */
export interface PreparedSignatureLinkEmail {
  /**
   * Cancela los emails aún pendientes de las solicitudes que esta anula
   * (`supersededIds`) y encola el del enlace nuevo con el tope contado bajo
   * el candado de la clínica y del destinatario. Si no cabe, lanza el 429 en
   * español y la transacción se deshace entera.
   */
  insert(tx: Prisma.TransactionClient, supersededIds: string[]): Promise<void>;
  kick(): void;
}

/**
 * Emails de la firma a distancia (DX-243) por el outbox (DX-088): el del
 * enlace, al enviarla, y el del código, cuando el paciente lo pide; DX-415, la
 * confirmación al aceptar un presupuesto. El texto va sin nada clínico (ver
 * las plantillas).
 */
export interface SignatureEmailSender {
  /** Topes del outbox por destinatario y clínica: pasarlos es un 429 en español. */
  assertCanSend(to: string): Promise<void>;
  /** DX-149-ter: el email del enlace, para la transacción de la solicitud. */
  prepareLink(input: {
    to: string;
    referenceId: string;
    vars: SignatureRequestEmailVars;
  }): Promise<PreparedSignatureLinkEmail>;
  sendCode(input: {
    to: string;
    referenceId: string;
    vars: SignatureCodeEmailVars;
  }): Promise<void>;
  /** DX-415: confirma al paciente que su aceptación quedó registrada. */
  sendBudgetAccepted(input: {
    to: string;
    referenceId: string;
    vars: SignatureBudgetAcceptedEmailVars;
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

  assertCanSend(to: string): Promise<void> {
    return withEmailQuotaAs429(() =>
      this.outbox.assertWithinQuota(
        tenantIdOf(this.tenantContext),
        to,
        'signature-request',
      ),
    );
  }

  async prepareLink(input: {
    to: string;
    referenceId: string;
    vars: SignatureRequestEmailVars;
  }): Promise<PreparedSignatureLinkEmail> {
    // Marca, plantilla y cifrado ANTES de abrir la transacción.
    const mail = await this.outbox.prepareInTx({
      tenantId: tenantIdOf(this.tenantContext),
      to: input.to,
      template: 'signature-request',
      vars: input.vars,
      referenceId: input.referenceId,
      enforceQuota: true,
    });
    return {
      insert: async (tx, supersededIds) => {
        for (const id of supersededIds) {
          await this.outbox.supersedePendingInTx(tx, id, 'signature-request');
        }
        await withEmailQuotaAs429(() => mail.insert(tx));
      },
      kick: () => mail.kick(),
    };
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

  async sendBudgetAccepted(input: {
    to: string;
    referenceId: string;
    vars: SignatureBudgetAcceptedEmailVars;
  }): Promise<void> {
    await this.outbox.enqueue({
      tenantId: tenantIdOf(this.tenantContext),
      to: input.to,
      template: 'signature-budget-accepted',
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
