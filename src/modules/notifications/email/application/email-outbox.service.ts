import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EmailBrand,
  EmailLocale,
  EmailTemplateName,
  EmailVarsByTemplate,
} from '../domain/email-message';
import { EMAIL_OUTBOX_REPOSITORY } from '../domain/ports/email-outbox-repository.port';
import type { EmailOutboxRepository } from '../domain/ports/email-outbox-repository.port';
import { EmailPayloadCipher } from '../infrastructure/email-payload-cipher';
import { maskEmail } from '../../../../shared/privacy/mask-email';
import { EmailDispatcher } from './email-dispatcher.service';
import { renderEmail } from './templates/templates';

export interface EnqueueEmailInput<T extends EmailTemplateName> {
  /** Clínica que envía (marca y RLS); sin ella es un email de plataforma. */
  tenantId?: string;
  to: string;
  template: T;
  vars: EmailVarsByTemplate[T];
  locale?: EmailLocale;
  /** Entidad que lo origina (p. ej. la invitación), para su estado de envío. */
  referenceId?: string;
}

/**
 * Puerta de entrada para enviar un email: renderiza la plantilla con la marca
 * de la clínica, cifra el mensaje, lo deja PENDING en `email_outbox` y
 * despierta al despachador. Devuelve en cuanto la fila está guardada: el
 * proveedor nunca está en el camino de la petición.
 */
@Injectable()
export class EmailOutbox {
  private readonly logger = new Logger('Email');

  constructor(
    @Inject(EMAIL_OUTBOX_REPOSITORY)
    private readonly repo: EmailOutboxRepository,
    private readonly cipher: EmailPayloadCipher,
    private readonly dispatcher: EmailDispatcher,
  ) {}

  async enqueue<T extends EmailTemplateName>(
    input: EnqueueEmailInput<T>,
  ): Promise<{ id: string }> {
    const tenantId = input.tenantId ?? null;
    const brand = tenantId ? await this.brandOf(tenantId) : null;
    const rendered = renderEmail(
      input.template,
      input.vars,
      brand,
      input.locale ?? 'es',
    );
    const to = input.to.trim();
    const toMasked = maskEmail(to);

    const { id } = await this.repo.insert({
      tenantId,
      template: input.template,
      toHash: this.cipher.hashRecipient(to),
      toMasked,
      referenceId: input.referenceId ?? null,
      payload: this.cipher.encrypt({ to, ...rendered }),
    });

    this.logger.log({
      event: 'email.enqueued',
      outboxId: id,
      tenantId,
      template: input.template,
      to: toMasked,
    });
    // La fila ya está confirmada (el insert cerró su transacción).
    this.dispatcher.kick();
    return { id };
  }

  /**
   * Cancela los envíos aún PENDING de una referencia: p. ej. el email con el
   * enlace anterior al reenviar o revocar una invitación (ese enlace ya no
   * sirve). Los que ya están saliendo no se pueden parar.
   */
  supersedePending(
    tenantId: string,
    referenceId: string,
    template: EmailTemplateName,
  ): Promise<number> {
    return this.repo.supersedePending(tenantId, referenceId, template);
  }

  private async brandOf(tenantId: string): Promise<EmailBrand | null> {
    const tenant = await this.repo.findBrand(tenantId);
    return tenant
      ? {
          clinicName: tenant.name,
          logoUrl: tenant.logoUrl,
          primaryColor: tenant.primaryColor,
        }
      : null;
  }
}
