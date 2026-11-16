import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  GoneException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { resolveCatalogLanguage } from '../../../shared/i18n/patient-language';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import { phoneRegionOrNull } from '../../../shared/phone/phone-number';
import {
  generatePublicLinkToken,
  hashPublicLinkToken,
  isWellFormedPublicLinkToken,
} from '../../../shared/public-links/public-link-token';
import {
  FILE_STORAGE,
  type FileStoragePort,
} from '../../../shared/storage/file-storage.port';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { TenantLinkBaseService } from '../../../shared/tenancy/tenant-link-base.service';
import { civilDateIn } from '../../../shared/time/civil-day';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import {
  EmailOutbox,
  type PreparedEmail,
} from '../../notifications/email/application/email-outbox.service';
import { withEmailQuotaAs429 } from '../../notifications/email/application/email-quota-http';
import {
  DEFAULT_EMAIL_LOCALE,
  EMAIL_LOCALES,
  type ExternalOrderCopyEmailVars,
} from '../../notifications/email/domain/email-message';
import { resolvePrescriptionCopyRecipient } from '../../prescriptions/domain/prescription-copy-recipient';
import {
  buildExternalOrderPdfModel,
  externalOrderFileName,
  type ExternalOrder,
} from '../domain/external-order';
import {
  EXTERNAL_ORDER_COPY_CONFIG,
  EXTERNAL_ORDER_EMAIL_WHAT,
  EXTERNAL_ORDER_COPY_NOT_FOUND_MESSAGE,
  EXTERNAL_ORDER_COPY_NO_LINK_HOST_MESSAGE,
  EXTERNAL_ORDER_COPY_USED_CODE,
  EXTERNAL_ORDER_COPY_USED_MESSAGE,
  EXTERNAL_ORDER_COPY_VOIDED_MESSAGE,
  buildExternalOrderCopyUrl,
  externalOrderCopyExpiresAt,
  externalOrderCopyLinkState,
  externalOrderRecipientMessage,
  externalOrderWhatsAppText,
  type ExternalOrderCopyChannel,
  type ExternalOrderCopyConfig,
} from '../domain/external-order-copy-link';
import { EXTERNAL_ORDER_MESSAGES } from '../domain/external-order-rules';
import {
  EXTERNAL_ORDER_PDF_RENDERER,
  type ExternalOrderPdfRenderer,
} from '../infrastructure/external-order-pdf.renderer';
import {
  EXTERNAL_ORDER_COPY_REPOSITORY,
  type PrismaExternalOrderCopyRepository,
  type PublicClinicBranding,
} from '../infrastructure/prisma-external-order-copy.repository';
import { loadFrozenLogo } from '../infrastructure/frozen-logo';
import {
  EXTERNAL_ORDER_CLOCK,
  type ExternalOrderActor,
  type ExternalOrderClock,
  type ExternalOrderPdf,
} from './external-orders.use-cases';

export const EXTERNAL_ORDER_COPY_EMAIL_SENDER = Symbol(
  'EXTERNAL_ORDER_COPY_EMAIL_SENDER',
);

/** El email de la copia por el outbox de DX-088 (como la copia de DX-468). */
export interface ExternalOrderCopyEmailSender {
  /** Aviso temprano de los topes del outbox, antes de tocar nada. */
  assertCanSend(to: string): Promise<void>;
  /**
   * Deja el email listo para encolarlo DENTRO de la transacción que crea el
   * enlace: `insert(tx)` dentro, `kick()` tras el COMMIT.
   */
  prepare(input: {
    to: string;
    referenceId: string;
    vars: ExternalOrderCopyEmailVars;
  }): Promise<PreparedEmail>;
}

function tenantIdOf(tenantContext: Pick<TenantContextService, 'getTenantId'>) {
  const tenantId = tenantContext.getTenantId();
  if (!tenantId) throw new Error('No tenant in context');
  return tenantId;
}

@Injectable()
export class OutboxExternalOrderCopyEmailSender implements ExternalOrderCopyEmailSender {
  constructor(
    private readonly outbox: EmailOutbox,
    private readonly tenantContext: TenantContextService,
  ) {}

  assertCanSend(to: string): Promise<void> {
    return withEmailQuotaAs429(() =>
      this.outbox.assertWithinQuota(
        tenantIdOf(this.tenantContext),
        to,
        'external-order-copy',
      ),
    );
  }

  async prepare(input: {
    to: string;
    referenceId: string;
    vars: ExternalOrderCopyEmailVars;
  }): Promise<PreparedEmail> {
    const mail = await this.outbox.prepareInTx({
      tenantId: tenantIdOf(this.tenantContext),
      to: input.to,
      template: 'external-order-copy',
      vars: input.vars,
      referenceId: input.referenceId,
      enforceQuota: true,
    });
    return {
      insert: (tx) => withEmailQuotaAs429(() => mail.insert(tx)),
      kick: () => mail.kick(),
    };
  }
}

/** Respuesta de «Enviar al paciente». */
export interface ExternalOrderCopySent {
  channel: ExternalOrderCopyChannel;
  sentAt: Date;
  expiresAt: Date;
  /** «a***@…» o «••• 4567»: nunca el contacto entero. */
  destinationMasked: string;
  recipientKind: 'PATIENT' | 'RESPONSIBLE';
  /** Solo por WhatsApp: el enlace (una vez), el número y el texto. */
  whatsapp: { phone: string; text: string; url: string } | null;
}

type CopyRepo = Pick<
  PrismaExternalOrderCopyRepository,
  | 'loadTarget'
  | 'issueLink'
  | 'findLinkByTokenHash'
  | 'orderOf'
  | 'consume'
  | 'recordPublicView'
  | 'findClinicBranding'
>;

/**
 * «Enviar al paciente» (DX-572): crea el enlace de un solo uso de la copia de
 * una orden ISSUED o RESULT_RECEIVED (el anterior deja de servir en la misma
 * transacción) y lo envía por email (outbox, en la transacción) o devuelve el
 * número, el enlace y el texto para que la web abra `wa.me`. Los 4 roles; 404
 * de otra clínica y 403 si la sede de la orden no está permitida. Un menor la
 * recibe por su responsable que recibe avisos (criterio de DX-468). La copia
 * del paciente SÍ lleva la nota clínica: es su dato y la lleva al centro.
 * Auditado por la ruta: SEND · EXTERNAL_ORDER_COPY_SENT.
 */
@Injectable()
export class SendExternalOrderCopyUseCase {
  constructor(
    @Inject(EXTERNAL_ORDER_COPY_REPOSITORY) private readonly copies: CopyRepo,
    @Inject(EXTERNAL_ORDER_COPY_EMAIL_SENDER)
    private readonly email: ExternalOrderCopyEmailSender,
    @Inject(TenantLinkBaseService)
    private readonly linkBase: Pick<TenantLinkBaseService, 'forTenant'>,
    @Inject(TenantContextService)
    private readonly tenantContext: Pick<
      TenantContextService,
      'getTenantId' | 'assertLocationAllowed'
    >,
    @Inject(EXTERNAL_ORDER_COPY_CONFIG)
    private readonly config: ExternalOrderCopyConfig,
    @Inject(EXTERNAL_ORDER_CLOCK) private readonly clock: ExternalOrderClock,
  ) {}

  async execute(
    orderId: string,
    channel: ExternalOrderCopyChannel,
    actor: ExternalOrderActor,
    requestHost?: string,
  ): Promise<ExternalOrderCopySent> {
    const target = await this.copies.loadTarget(orderId);
    if (!target) throw new NotFoundException(EXTERNAL_ORDER_MESSAGES.notFound);
    // SEC-045: de una sede no permitida, 403 antes de mirar nada más.
    this.tenantContext.assertLocationAllowed(target.locationId);
    if (target.status === 'VOIDED') {
      throw new ConflictException(EXTERNAL_ORDER_COPY_VOIDED_MESSAGE);
    }
    const order = await this.copies.orderOf(orderId);
    if (!order) throw new NotFoundException(EXTERNAL_ORDER_MESSAGES.notFound);
    const now = this.clock();
    const timeZone = requireLocationTimeZone(target.location);
    const recipient = resolvePrescriptionCopyRecipient({
      channel,
      patient: target.patient,
      responsibles: target.responsibles,
      majorityAge: target.majorityAge,
      today: civilDateIn(now, timeZone),
      phoneRegion: phoneRegionOrNull(target.location.phoneRegion),
    });
    if (!recipient.ok) {
      throw new UnprocessableEntityException(
        externalOrderRecipientMessage(recipient.reason),
      );
    }
    const format = requireLocationFormat(target.location);
    if (channel === 'EMAIL') {
      await this.email.assertCanSend(recipient.destination);
    }
    const base = await this.linkBase.forTenant(
      tenantIdOf(this.tenantContext),
      requestHost,
    );
    if (!base) {
      throw new ConflictException(EXTERNAL_ORDER_COPY_NO_LINK_HOST_MESSAGE);
    }

    const expiresAt = externalOrderCopyExpiresAt(now, this.config.ttlHours);
    const token = generatePublicLinkToken();
    const url = buildExternalOrderCopyUrl(base, token);
    const expiresAtLabel = format.dateTime(expiresAt, timeZone);
    const linkId = randomUUID();
    const mail =
      channel === 'EMAIL'
        ? await this.email.prepare({
            to: recipient.destination,
            referenceId: linkId,
            vars: {
              recipientFirstName: recipient.greetingName,
              patientFirstName: recipient.patientFirstName,
              clinicName: target.clinicName,
              documentLabel: EXTERNAL_ORDER_EMAIL_WHAT[order.kind],
              url,
              expiresAtLabel,
            },
          })
        : null;
    const outcome = await this.copies.issueLink({
      id: linkId,
      orderId,
      patientId: target.patientId,
      channel,
      destinationMasked: recipient.destinationMasked,
      tokenHash: hashPublicLinkToken(token),
      expiresAt,
      createdById: actor.userId,
      now,
      enqueue: mail
        ? async (tx) => {
            await mail.insert(tx);
          }
        : undefined,
    });
    if (outcome === 'NOT_FOUND') {
      throw new NotFoundException(EXTERNAL_ORDER_MESSAGES.notFound);
    }
    if (outcome === 'VOIDED') {
      throw new ConflictException(EXTERNAL_ORDER_COPY_VOIDED_MESSAGE);
    }
    mail?.kick();
    // DX-497: el idioma del paciente si hay texto; si no, español.
    const { language } = resolveCatalogLanguage(
      target.patient.preferredLanguage,
      EMAIL_LOCALES,
      DEFAULT_EMAIL_LOCALE,
    );
    return {
      channel,
      sentAt: now,
      expiresAt,
      destinationMasked: recipient.destinationMasked,
      recipientKind: recipient.kind,
      whatsapp:
        channel === 'WHATSAPP'
          ? {
              phone: recipient.destination,
              url,
              text: externalOrderWhatsAppText({
                language,
                kind: order.kind,
                name: recipient.greetingName,
                clinic: target.clinicName,
                patient: recipient.patientFirstName,
                expiresAtLabel,
                url,
              }),
            }
          : null,
    };
  }
}

/** Lo que ve quien abre el enlace válido: datos mínimos, nada clínico. */
export interface PublicExternalOrderCopyView {
  status: 'AVAILABLE' | 'USED';
  clinic: PublicClinicBranding | null;
  expiresAt: Date;
  order: ExternalOrder;
}

function linkUsed(): GoneException {
  return new GoneException({
    statusCode: HttpStatus.GONE,
    error: 'Gone',
    code: EXTERNAL_ORDER_COPY_USED_CODE,
    message: EXTERNAL_ORDER_COPY_USED_MESSAGE,
  });
}

/**
 * Abrir la copia y descargar su PDF (`/public/external-order-copies/:token`).
 * Sin sesión: la clínica sale SOLO del host (DX-207) y todo va bajo su RLS.
 * Inventado, mal formado, de otra clínica, caducado, invalidado, de una orden
 * anulada o del paciente archivado: el mismo 404. Abrir NO gasta el enlace;
 * descargar sí (410 con su código si ya se usó). Cada apertura (VIEW) y la
 * descarga (EXPORT) quedan auditadas sin usuario, origen PUBLIC_LINK.
 */
@Injectable()
export class PublicExternalOrderCopyUseCase {
  constructor(
    @Inject(EXTERNAL_ORDER_COPY_REPOSITORY) private readonly copies: CopyRepo,
    @Inject(EXTERNAL_ORDER_PDF_RENDERER)
    private readonly renderer: ExternalOrderPdfRenderer,
    @Inject(FILE_STORAGE)
    private readonly storage: Pick<FileStoragePort, 'read'>,
    @Inject(TenantContextService)
    private readonly tenantContext: Pick<TenantContextService, 'getTenantId'>,
    @Inject(EXTERNAL_ORDER_CLOCK) private readonly clock: ExternalOrderClock,
  ) {}

  private async link(token: string) {
    if (
      !this.tenantContext.getTenantId() ||
      !isWellFormedPublicLinkToken(token)
    ) {
      throw new NotFoundException(EXTERNAL_ORDER_COPY_NOT_FOUND_MESSAGE);
    }
    const link = await this.copies.findLinkByTokenHash(
      hashPublicLinkToken(token),
    );
    if (!link) {
      throw new NotFoundException(EXTERNAL_ORDER_COPY_NOT_FOUND_MESSAGE);
    }
    return link;
  }

  async view(
    token: string,
    meta: AuditRequestMeta,
  ): Promise<PublicExternalOrderCopyView> {
    const link = await this.link(token);
    const state = externalOrderCopyLinkState(link, this.clock());
    if (state === 'GONE') {
      throw new NotFoundException(EXTERNAL_ORDER_COPY_NOT_FOUND_MESSAGE);
    }
    const order = await this.copies.orderOf(link.orderId);
    if (!order || order.status === 'VOIDED') {
      throw new NotFoundException(EXTERNAL_ORDER_COPY_NOT_FOUND_MESSAGE);
    }
    await this.copies.recordPublicView({
      orderId: order.id,
      patientId: order.patientId,
      locationId: order.locationId,
      meta,
    });
    const clinic = await this.copies.findClinicBranding();
    return { status: state, clinic, expiresAt: link.expiresAt, order };
  }

  /** Gasta el enlace y devuelve el PDF CON la nota (es su dato). */
  async download(
    token: string,
    meta: AuditRequestMeta,
  ): Promise<ExternalOrderPdf> {
    const link = await this.link(token);
    const outcome = await this.copies.consume({
      linkId: link.id,
      now: this.clock(),
      meta,
      render: async (order) =>
        this.renderer.render(
          buildExternalOrderPdfModel(order, {
            withNote: true,
            logo: await loadFrozenLogo(this.storage, order.clinicLogoKey),
          }),
        ),
    });
    if (outcome.kind === 'USED') throw linkUsed();
    if (outcome.kind === 'GONE') {
      throw new NotFoundException(EXTERNAL_ORDER_COPY_NOT_FOUND_MESSAGE);
    }
    return {
      pdf: outcome.pdf,
      fileName: externalOrderFileName(
        outcome.order.kind,
        outcome.order.number,
        false,
      ),
    };
  }
}
