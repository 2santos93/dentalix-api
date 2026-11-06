import { Injectable } from '@nestjs/common';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import type { PostOpInstructionsEmailVars } from '../../notifications/email/domain/email-message';
import { withEmailQuotaAs429 } from '../../notifications/email/application/email-quota-http';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';

export interface PostOpEmailSendInput {
  to: string;
  vars: PostOpInstructionsEmailVars;
  /** La entrega que lo origina (estado de envío en el outbox). */
  referenceId: string;
}

export const POSTOP_EMAIL_SENDER = Symbol('POSTOP_EMAIL_SENDER');

/**
 * DX-250: hasta cuándo el outbox da fe de un envío. Una entrega EMAIL anterior
 * a este instante pudo salir y haber sido purgada del outbox (retención de
 * `MAIL_OUTBOX_RETENTION_DAYS`): sin fila ya no se sabe (ni se afirma «no
 * enviado»). Es una función para leer el reloj y la retención al llamarla.
 */
export const POSTOP_EMAIL_EVIDENCE_CUTOFF = Symbol(
  'POSTOP_EMAIL_EVIDENCE_CUTOFF',
);
export type PostOpEmailEvidenceCutoff = () => Date;

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

  assertCanSend(to: string): Promise<void> {
    return withEmailQuotaAs429(() =>
      this.outbox.assertWithinQuota(tenantIdOf(this.tenantContext), to),
    );
  }

  /**
   * DX-149-ter: con `enforceQuota`, el tope se vuelve a contar al encolar,
   * bajo el candado de la clínica y del destinatario: dos entregas a la vez
   * que pasaron el aviso temprano no salen las dos. El que pierde es el 429;
   * el caso de uso lo deja en `emailQueued: false` (la entrega ya está).
   */
  async send(input: PostOpEmailSendInput): Promise<void> {
    await withEmailQuotaAs429(() =>
      this.outbox.enqueue({
        tenantId: tenantIdOf(this.tenantContext),
        to: input.to,
        template: 'post-op-instructions',
        vars: input.vars,
        referenceId: input.referenceId,
        enforceQuota: true,
      }),
    );
  }
}
