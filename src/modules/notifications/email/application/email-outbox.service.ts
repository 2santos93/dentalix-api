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
import { MAIL_CONFIG } from '../infrastructure/mail-config';
import type { MailConfig } from '../infrastructure/mail-config';
import { EmailQuotaExceededError } from '../domain/email-quota-exceeded.error';
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
    @Inject(MAIL_CONFIG) private readonly config: MailConfig,
  ) {}

  /**
   * Topes anti-abuso (DX-088, revisión B1), contados en la BD (valen con
   * varias réplicas): como mucho un email cada N s y M al día al MISMO
   * destinatario de la clínica (cubre reenviar e invitar otra vez al mismo
   * correo), y un máximo diario por clínica. Se llama ANTES de cambiar nada
   * (crear la invitación, regenerar el token). Lanza EmailQuotaExceededError.
   */
  async assertWithinQuota(tenantId: string, to: string): Promise<void> {
    const { quotas } = this.config;
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const sends = await this.repo.recentSends(
      tenantId,
      this.cipher.hashRecipient(to),
      dayAgo,
    );
    if (sends.lastToRecipient && quotas.recipientCooldownSeconds > 0) {
      const elapsed = Math.floor(
        (now - sends.lastToRecipient.getTime()) / 1000,
      );
      if (elapsed < quotas.recipientCooldownSeconds) {
        const wait = quotas.recipientCooldownSeconds - elapsed;
        throw new EmailQuotaExceededError(
          `Ya enviamos un correo a esta persona hace un momento. Espera ${wait} ${wait === 1 ? 'segundo' : 'segundos'} antes de volver a enviarlo.`,
          wait,
        );
      }
    }
    if (sends.recipient >= quotas.recipientDaily) {
      throw new EmailQuotaExceededError(
        `Ya enviamos ${quotas.recipientDaily} correos a esta persona en las últimas 24 horas. Vuelve a intentarlo mañana o comparte el enlace por otro medio.`,
        60 * 60,
      );
    }
    if (sends.tenant >= quotas.tenantDaily) {
      throw new EmailQuotaExceededError(
        `La clínica alcanzó el máximo de ${quotas.tenantDaily} correos en 24 horas. Vuelve a intentarlo más tarde o escribe a soporte si necesitas más.`,
        60 * 60,
      );
    }
  }

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
