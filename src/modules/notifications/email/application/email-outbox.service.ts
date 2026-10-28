import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EmailBrand,
  EmailLocale,
  EmailTemplateName,
  EmailVarsByTemplate,
  RenderedEmail,
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

/** Email de plataforma (sin clínica): firma Dentalix y tiene tope propio. */
export interface EnqueuePlatformEmailInput<T extends EmailTemplateName> {
  to: string;
  template: T;
  vars: EmailVarsByTemplate[T];
  locale?: EmailLocale;
  /** Entidad que lo origina (p. ej. la invitación), para su estado de envío. */
  referenceId?: string;
}

export interface EnqueueEmailInput<
  T extends EmailTemplateName,
> extends EnqueuePlatformEmailInput<T> {
  /** Clínica que envía (marca y RLS). Sin clínica: `enqueuePlatform`. */
  tenantId: string;
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
    const sends = await this.repo.recentSends(
      tenantId,
      this.cipher.hashRecipient(to),
    );
    if (
      sends.secondsSinceLastToRecipient !== null &&
      quotas.recipientCooldownSeconds > 0
    ) {
      const elapsed = Math.floor(sends.secondsSinceLastToRecipient);
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
        `Ya enviamos ${quotas.recipientDaily} correos a esta persona en las últimas 24 horas. Vuelve a intentarlo mañana.`,
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
    const brand = await this.brandOf(input.tenantId);
    const row = this.prepare(input, brand);
    const { id } = await this.repo.insert({ ...row, tenantId: input.tenantId });
    this.enqueued(id, input.tenantId, input.template, row.toMasked);
    return { id };
  }

  /**
   * DX-291: el email tal como saldría para la clínica (asunto, HTML y texto
   * con su marca), SIN encolarlo ni registrarlo: la vista previa de Ajustes.
   */
  async preview<T extends EmailTemplateName>(
    tenantId: string,
    template: T,
    vars: EmailVarsByTemplate[T],
  ): Promise<RenderedEmail> {
    return renderEmail(template, vars, await this.brandOf(tenantId));
  }

  /**
   * Segundos mínimos entre dos emails de plataforma al mismo destinatario
   * (DX-144). El registro no reemplaza un pendiente más joven que esto.
   */
  get platformRecipientCooldownSeconds(): number {
    return this.config.platformQuotas.recipientCooldownSeconds;
  }

  /**
   * ¿Cabe otro email de plataforma a `to`? Lo cuenta la BD por el hash del
   * destinatario (vale entre réplicas). No escribe nada.
   */
  withinPlatformRecipientQuota(to: string): Promise<boolean> {
    return this.repo.platformRecipientAllowed(
      this.cipher.hashRecipient(to),
      this.config.platformQuotas,
    );
  }

  /**
   * Email de PLATAFORMA (sin clínica, firma Dentalix: verificación y aviso del
   * registro público). Solo sale si cabe en el tope por destinatario
   * (DX-144, SEC-034: el alta pública no puede servir para bombardear un
   * buzón con el DKIM de Dentalix); la comprobación y la escritura son una
   * sola operación en la BD. `null` si el tope lo frenó: quien llama decide
   * qué hacer, y NUNCA se lo dice a quien hizo la petición pública.
   */
  async enqueuePlatform<T extends EmailTemplateName>(
    input: EnqueuePlatformEmailInput<T>,
  ): Promise<{ id: string } | null> {
    const row = this.prepare(input, null);
    const created = await this.repo.insertPlatform(
      row,
      this.config.platformQuotas,
    );
    if (!created) {
      this.logger.log({
        event: 'email.platform_recipient_capped',
        template: input.template,
        to: row.toMasked,
      });
      return null;
    }
    this.enqueued(created.id, null, input.template, row.toMasked);
    return created;
  }

  private prepare<T extends EmailTemplateName>(
    input: EnqueuePlatformEmailInput<T>,
    brand: EmailBrand | null,
  ) {
    const rendered = renderEmail(
      input.template,
      input.vars,
      brand,
      input.locale ?? 'es',
    );
    const to = input.to.trim();
    return {
      template: input.template,
      toHash: this.cipher.hashRecipient(to),
      toMasked: maskEmail(to),
      referenceId: input.referenceId ?? null,
      payload: this.cipher.encrypt({ to, ...rendered }),
    };
  }

  private enqueued(
    id: string,
    tenantId: string | null,
    template: EmailTemplateName,
    toMasked: string,
  ): void {
    this.logger.log({
      event: 'email.enqueued',
      outboxId: id,
      tenantId,
      template,
      to: toMasked,
    });
    // La fila ya está confirmada (el insert cerró su transacción).
    this.dispatcher.kick();
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
