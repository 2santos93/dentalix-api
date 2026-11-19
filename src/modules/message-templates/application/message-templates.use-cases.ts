import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import { withEmailQuotaAs429 } from '../../notifications/email/application/email-quota-http';
import { EmailQuotaExceededError } from '../../notifications/email/domain/email-quota-exceeded.error';
import type { EditableEmailTemplate } from '../../notifications/email/application/templates/editable-text';
import { maskEmail } from '../../../shared/privacy/mask-email';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  MESSAGE_CATALOG,
  MESSAGE_CHANNELS,
  MESSAGE_KEYS,
  MESSAGE_LANGUAGES,
  MESSAGE_SUBJECT_MAX,
  MESSAGE_SYNTAX_HELP,
  defaultMessageText,
  isMessageChannel,
  isMessageKey,
  isMessageLanguage,
  messageBodyMax,
  messageChannelSpec,
  offeredMessageLanguages,
  type MessageChannel,
  type MessageKey,
  type MessageLanguage,
  type MessageText,
} from '../domain/message-catalog';
import {
  storedMessageTemplateProblem,
  validateMessageTemplate,
  type MessageTemplateField,
} from '../domain/message-template-engine';
import {
  MESSAGE_VARIABLE_INFO,
  type MessageVariable,
} from '../domain/message-variables';
import {
  confirmationWhatsAppText,
  linkOfferWhatsAppText,
} from '../domain/whatsapp-messages';
import {
  MESSAGE_TEMPLATE_REPOSITORY,
  type MessageTemplateId,
  type MessageTemplateRepository,
  type StoredMessageTemplate,
} from '../domain/ports/message-template-repository.port';
import {
  sampleConfirmationInput,
  sampleEmailVars,
  sampleLinkOfferInput,
} from './message-samples';

export const MESSAGE_TEMPLATE_NOT_FOUND_MESSAGE =
  'Ese mensaje no existe o no se envía por ese canal.';
export const MESSAGE_TEMPLATE_LANGUAGE_MESSAGE =
  'Ese mensaje no se puede escribir en ese idioma: elige uno de la lista de idiomas de los pacientes de la clínica (Ajustes › Idiomas de los pacientes).';
export const MESSAGE_TEMPLATE_TEST_WHATSAPP_MESSAGE =
  'La prueba solo se envía por email. Para WhatsApp, copia el texto de la vista previa.';
export const MESSAGE_TEMPLATE_NOT_VERIFIED_MESSAGE =
  'Confirma tu correo antes de pedir una prueba: solo se envía a correos confirmados.';
export const MESSAGE_TEMPLATE_TEST_PREFIX = '[Prueba] ';
/** Una prueba por persona cada 5 minutos (D4). */
export const MESSAGE_TEMPLATE_TEST_COOLDOWN_SECONDS = 5 * 60;

function testWaitMessage(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  return seconds < 60
    ? `Ya te enviamos una prueba hace un momento. Espera ${seconds} ${seconds === 1 ? 'segundo' : 'segundos'} para pedir otra.`
    : `Ya te enviamos una prueba hace un momento. Espera ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} para pedir otra.`;
}

/** 400 con el campo (`subject` | `body`) para pintarlo junto a él. */
export function messageTemplateInvalid(
  field: MessageTemplateField,
  message: string,
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'MESSAGE_TEMPLATE_INVALID',
    field,
    message,
  });
}

export interface MessageVariableView {
  name: MessageVariable;
  description: string;
  sample: string;
}

export interface MessageCustomView extends MessageText {
  updatedAt: Date;
  updatedByName: string | null;
  /**
   * H14: por qué este texto ya no sale (el catálogo cambió) y en su lugar
   * sale el de por defecto; null si sale.
   */
  invalid: string | null;
}

export interface MessageLanguageView {
  language: MessageLanguage;
  /** En la lista de idiomas de la clínica (si no, solo se puede restablecer). */
  offered: boolean;
  default: MessageText;
  /** El texto guardado, o null = sale el de por defecto. */
  custom: MessageCustomView | null;
}

export interface MessageChannelView {
  channel: MessageChannel;
  variables: MessageVariableView[];
  required: MessageVariable[];
  /** null en WhatsApp (sin asunto). */
  subjectMaxLength: number | null;
  bodyMaxLength: number;
  languages: MessageLanguageView[];
}

export interface MessageView {
  key: MessageKey;
  title: string;
  description: string;
  /** Al responsable de un menor le llega siempre el texto por defecto. */
  guardianUsesDefault: boolean;
  channels: MessageChannelView[];
}

export interface MessageTemplatesView {
  /** Idiomas de la clínica con texto en el catálogo (es siempre primero). */
  languages: MessageLanguage[];
  /** La sintaxis y sus límites, para la ayuda del editor (H13). */
  syntaxHelp: string;
  messages: MessageView[];
}

export interface MessageTemplateView extends MessageLanguageView {
  key: MessageKey;
  channel: MessageChannel;
}

export interface MessagePreview {
  channel: MessageChannel;
  /** Email: asunto, HTML y texto plano. WhatsApp: solo `text`. */
  subject: string | null;
  html: string | null;
  text: string;
}

export interface MessageTestResult {
  /** El correo de quien la pidió, enmascarado. */
  sentTo: string;
}

function customOf(
  row: StoredMessageTemplate | undefined,
  id: { key: MessageKey; channel: MessageChannel },
): MessageCustomView | null {
  return row
    ? {
        subject: row.subject,
        body: row.body,
        updatedAt: row.updatedAt,
        updatedByName: row.updatedByName,
        invalid: storedMessageTemplateProblem(id.key, id.channel, {
          subject: row.subject,
          body: row.body,
        }),
      }
    : null;
}

/**
 * Los parámetros de la ruta: 404 si (clave, canal) no existe; 400 si el idioma
 * no tiene texto en el catálogo o, para escribir, la clínica no lo ofrece.
 */
function resolveId(
  raw: { key: string; channel: string; language: string },
  offered: readonly MessageLanguage[] | null,
): MessageTemplateId {
  const { key, channel, language } = raw;
  if (
    !isMessageKey(key) ||
    !isMessageChannel(channel) ||
    !messageChannelSpec(key, channel)
  ) {
    throw new NotFoundException(MESSAGE_TEMPLATE_NOT_FOUND_MESSAGE);
  }
  if (
    !isMessageLanguage(language) ||
    !defaultMessageText(key, channel, language) ||
    (offered && !offered.includes(language))
  ) {
    throw new BadRequestException(MESSAGE_TEMPLATE_LANGUAGE_MESSAGE);
  }
  return { key, channel, language };
}

function validated(
  id: MessageTemplateId,
  input: { subject?: string | null; body: string },
): MessageText {
  const result = validateMessageTemplate(id.key, id.channel, input);
  if (!result.ok) throw messageTemplateInvalid(result.field, result.message);
  return result.text;
}

const rowKey = (r: { key: string; channel: string; language: string }) =>
  `${r.key}|${r.channel}|${r.language}`;

/** `GET /message-templates`: el catálogo con los textos de la clínica. */
@Injectable()
export class ListMessageTemplatesUseCase {
  constructor(
    @Inject(MESSAGE_TEMPLATE_REPOSITORY)
    private readonly repo: MessageTemplateRepository,
  ) {}

  async execute(): Promise<MessageTemplatesView> {
    const [rows, patientLanguages] = await Promise.all([
      this.repo.list(),
      this.repo.patientLanguages(),
    ]);
    const offered = offeredMessageLanguages(patientLanguages);
    const byKey = new Map(rows.map((r) => [rowKey(r), r]));
    return {
      languages: offered,
      syntaxHelp: MESSAGE_SYNTAX_HELP,
      messages: MESSAGE_KEYS.map((key) => {
        const spec = MESSAGE_CATALOG[key];
        return {
          key,
          title: spec.title,
          description: spec.description,
          guardianUsesDefault: spec.guardianUsesDefault,
          channels: MESSAGE_CHANNELS.flatMap((channel) => {
            const ch = spec.channels[channel];
            if (!ch) return [];
            return [
              {
                channel,
                variables: ch.variables.map((name) => ({
                  name,
                  ...MESSAGE_VARIABLE_INFO[name],
                })),
                required: [...ch.required],
                subjectMaxLength:
                  channel === 'EMAIL' ? MESSAGE_SUBJECT_MAX : null,
                bodyMaxLength: messageBodyMax(channel),
                // Los idiomas ofrecidos y, aunque la clínica lo haya
                // retirado, el que tenga un texto guardado (para restablecerlo).
                languages: MESSAGE_LANGUAGES.flatMap((language) => {
                  const defaults = ch.defaults[language];
                  const row = byKey.get(rowKey({ key, channel, language }));
                  if (!defaults || (!offered.includes(language) && !row)) {
                    return [];
                  }
                  return [
                    {
                      language,
                      offered: offered.includes(language),
                      default: defaults,
                      custom: customOf(row, { key, channel }),
                    },
                  ];
                }),
              },
            ];
          }),
        };
      }),
    };
  }
}

/** `PUT /message-templates/:key/:channel/:language`. */
@Injectable()
export class SaveMessageTemplateUseCase {
  constructor(
    @Inject(MESSAGE_TEMPLATE_REPOSITORY)
    private readonly repo: MessageTemplateRepository,
  ) {}

  async execute(
    raw: { key: string; channel: string; language: string },
    input: { subject?: string | null; body: string },
    ctx: AuditRequestContext,
  ): Promise<MessageTemplateView> {
    const offered = offeredMessageLanguages(await this.repo.patientLanguages());
    const id = resolveId(raw, offered);
    const text = validated(id, input);
    const row = await this.repo.save(id, text, ctx);
    return {
      ...id,
      offered: true,
      default: defaultMessageText(id.key, id.channel, id.language)!,
      custom: customOf(row, id),
    };
  }
}

/** `DELETE /message-templates/:key/:channel/:language`: vuelve al texto por defecto. */
@Injectable()
export class ResetMessageTemplateUseCase {
  constructor(
    @Inject(MESSAGE_TEMPLATE_REPOSITORY)
    private readonly repo: MessageTemplateRepository,
  ) {}

  async execute(
    raw: { key: string; channel: string; language: string },
    ctx: AuditRequestContext,
  ): Promise<MessageTemplateView> {
    // Se puede restablecer también un idioma que la clínica ya retiró.
    const id = resolveId(raw, null);
    await this.repo.reset(id, ctx);
    const offered = offeredMessageLanguages(await this.repo.patientLanguages());
    return {
      ...id,
      offered: offered.includes(id.language),
      default: defaultMessageText(id.key, id.channel, id.language)!,
      custom: null,
    };
  }
}

/**
 * `POST …/preview`: el borrador renderizado con datos de ejemplo y la marca
 * de la clínica, sin guardar ni enviar nada.
 */
@Injectable()
export class PreviewMessageTemplateUseCase {
  constructor(
    @Inject(MESSAGE_TEMPLATE_REPOSITORY)
    private readonly repo: MessageTemplateRepository,
    private readonly email: EmailOutbox,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    raw: { key: string; channel: string; language: string },
    input: { subject?: string | null; body: string },
  ): Promise<MessagePreview> {
    const offered = offeredMessageLanguages(await this.repo.patientLanguages());
    const id = resolveId(raw, offered);
    const text = validated(id, input);
    const clinicName = (await this.repo.clinicName()) ?? '';
    if (id.channel === 'WHATSAPP') {
      return {
        channel: id.channel,
        subject: null,
        html: null,
        text:
          id.key === 'slot-offer'
            ? linkOfferWhatsAppText(sampleLinkOfferInput(clinicName), text)
            : confirmationWhatsAppText(
                sampleConfirmationInput(clinicName, id.language),
                text,
              ),
      };
    }
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    const template = id.key as EditableEmailTemplate;
    const email = await this.email.preview(
      tenantId,
      template,
      sampleEmailVars(template, clinicName),
      { locale: id.language, messageText: text },
    );
    return { channel: id.channel, ...email };
  }
}

/**
 * `POST …/test`: el email con el borrador (o, sin cuerpo, lo guardado o el
 * texto por defecto) y datos de ejemplo, AHORA y solo a quien lo pide si su
 * correo está confirmado, con «[Prueba]» en el asunto. Una por persona cada 5
 * minutos (429), con los topes del outbox y auditada (VIEW de
 * CLINIC_SETTINGS) en la transacción que encola el email.
 */
@Injectable()
export class SendMessageTemplateTestUseCase {
  constructor(
    @Inject(MESSAGE_TEMPLATE_REPOSITORY)
    private readonly repo: MessageTemplateRepository,
    private readonly email: EmailOutbox,
  ) {}

  execute(
    raw: { key: string; channel: string; language: string },
    input: { subject?: string | null; body?: string | null } | null,
    ctx: AuditRequestContext,
  ): Promise<MessageTestResult> {
    return withEmailQuotaAs429(() => this.send(raw, input, ctx));
  }

  private async send(
    raw: { key: string; channel: string; language: string },
    input: { subject?: string | null; body?: string | null } | null,
    ctx: AuditRequestContext,
  ): Promise<MessageTestResult> {
    const offered = offeredMessageLanguages(await this.repo.patientLanguages());
    const id = resolveId(raw, offered);
    if (id.channel !== 'EMAIL') {
      throw new BadRequestException(MESSAGE_TEMPLATE_TEST_WHATSAPP_MESSAGE);
    }
    // Con cuerpo, el borrador; sin él, lo guardado (lo lee el outbox) o el de siempre.
    const draft =
      input?.body != null
        ? validated(id, { subject: input.subject, body: input.body })
        : undefined;
    const me = await this.repo.testRecipient(ctx.actor.userId);
    if (!me) throw new NotFoundException(MESSAGE_TEMPLATE_NOT_FOUND_MESSAGE);
    if (!me.verified) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'EMAIL_NOT_VERIFIED',
        message: MESSAGE_TEMPLATE_NOT_VERIFIED_MESSAGE,
      });
    }
    // Aviso temprano; el que manda va bajo candado (reloj de la BD).
    const wait = await this.repo.testCooldownRemaining(
      ctx.actor.userId,
      MESSAGE_TEMPLATE_TEST_COOLDOWN_SECONDS,
    );
    if (wait > 0)
      throw new EmailQuotaExceededError(testWaitMessage(wait), wait);

    const template = id.key as EditableEmailTemplate;
    const prepared = await this.email.prepareInTx({
      tenantId: ctx.tenantId,
      to: me.email,
      template,
      locale: id.language,
      vars: sampleEmailVars(template, (await this.repo.clinicName()) ?? ''),
      ...(draft ? { messageText: draft } : {}),
      subjectPrefix: MESSAGE_TEMPLATE_TEST_PREFIX,
      // Lo pide una persona: aplica los topes de la clínica y del destinatario.
      enforceQuota: true,
    });
    const recorded = await this.repo.recordTestSend(
      prepared,
      id,
      draft !== undefined,
      ctx,
      MESSAGE_TEMPLATE_TEST_COOLDOWN_SECONDS,
    );
    if (!recorded.ok) {
      throw new EmailQuotaExceededError(
        testWaitMessage(recorded.retryAfterSeconds),
        recorded.retryAfterSeconds,
      );
    }
    prepared.kick();
    return { sentTo: maskEmail(me.email) };
  }
}

/**
 * DX-565: lee el texto guardado para un mensaje de WhatsApp de la clínica del
 * contexto (lo usan la confirmación y la oferta de hueco al crear el enlace).
 */
@Injectable()
export class MessageTemplateReader {
  constructor(
    @Inject(MESSAGE_TEMPLATE_REPOSITORY)
    private readonly repo: MessageTemplateRepository,
  ) {}

  /** Solo de un idioma que la clínica ofrece hoy (H8); si no, null. */
  async find(id: MessageTemplateId): Promise<MessageText | null> {
    const offered = offeredMessageLanguages(await this.repo.patientLanguages());
    return offered.includes(id.language) ? this.repo.find(id) : null;
  }

  /** El nombre de la clínica del contexto (la variable `{clinica}`). */
  clinicName(): Promise<string | null> {
    return this.repo.clinicName();
  }
}
