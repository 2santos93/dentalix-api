import {
  ConflictException,
  GoneException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { resolveCatalogLanguage } from '../../../../shared/i18n/patient-language';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';
import { requireLocationTimeZone } from '../../../../shared/locations/location-time-zone';
import { phoneRegionOrNull } from '../../../../shared/phone/phone-number';
import {
  generatePublicLinkToken,
  hashPublicLinkToken,
  isWellFormedPublicLinkToken,
} from '../../../../shared/public-links/public-link-token';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { TenantLinkBaseService } from '../../../../shared/tenancy/tenant-link-base.service';
import { civilDateIn } from '../../../../shared/time/civil-day';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import {
  EmailOutbox,
  type PreparedEmail,
} from '../../../notifications/email/application/email-outbox.service';
import { withEmailQuotaAs429 } from '../../../notifications/email/application/email-quota-http';
import { PRESCRIPTION_COPY_CATALOG } from '../../../notifications/email/application/templates/catalog/prescription-copy.catalog';
import {
  DEFAULT_EMAIL_LOCALE,
  EMAIL_LOCALES,
  type EmailLocale,
  type PrescriptionCopyEmailVars,
} from '../../../notifications/email/domain/email-message';
import type { PrescriptionDocument } from '../../domain/entities/prescription.entity';
import {
  PRESCRIPTION_COPY_CONFIG,
  PRESCRIPTION_COPY_EXPIRED_CODE,
  PRESCRIPTION_COPY_EXPIRED_MESSAGE,
  PRESCRIPTION_COPY_NOT_FOUND_MESSAGE,
  buildPrescriptionCopyUrl,
  prescriptionCopyExpiresAt,
  prescriptionCopyFooter,
  prescriptionCopyLinkState,
  type PrescriptionCopyChannel,
  type PrescriptionCopyConfig,
} from '../../domain/prescription-copy-link';
import { resolvePrescriptionCopyRecipient } from '../../domain/prescription-copy-recipient';
import { expectedPrescriptionHash } from '../../domain/prescription-hash';
import {
  PRESCRIPTION_COPY_REPOSITORY,
  type PrescriptionCopyRepository,
} from '../../domain/ports/prescription-copy-repository.port';
import {
  PRESCRIPTION_REPOSITORY,
  type PrescriptionRepository,
} from '../../domain/ports/prescription-repository.port';
import {
  PRESCRIPTION_SETTINGS_REPOSITORY,
  type PrescriptionSettingsRepository,
} from '../../domain/ports/prescription-settings-repository.port';
import {
  PRESCRIPTION_CLOCK,
  PRESCRIPTION_NOT_FOUND_MESSAGE,
  type PrescriptionClock,
} from './prescriptions.use-cases';

export const PRESCRIPTION_COPY_VOIDED_MESSAGE =
  'La receta está anulada: no se envía al paciente.';
export const PRESCRIPTION_COPY_NO_LINK_HOST_MESSAGE =
  'No se pudo armar el enlace de la clínica: revisa su subdominio.';

export const PRESCRIPTION_COPY_EMAIL_SENDER = Symbol(
  'PRESCRIPTION_COPY_EMAIL_SENDER',
);

/** El email de la copia por el outbox de DX-088 (como la copia de DX-443). */
export interface PrescriptionCopyEmailSender {
  /** Aviso temprano de los topes del outbox, antes de tocar nada. */
  assertCanSend(to: string): Promise<void>;
  /**
   * Deja el email listo para encolarlo DENTRO de la transacción que crea el
   * enlace (DX-463): `insert(tx)` dentro, `kick()` tras el COMMIT. El tope se
   * vuelve a contar al insertar, bajo candado (DX-149-ter).
   */
  prepare(input: {
    to: string;
    referenceId: string;
    locale: EmailLocale;
    vars: PrescriptionCopyEmailVars;
  }): Promise<PreparedEmail>;
}

function tenantIdOf(tenantContext: Pick<TenantContextService, 'getTenantId'>) {
  const tenantId = tenantContext.getTenantId();
  if (!tenantId) throw new Error('No tenant in context');
  return tenantId;
}

@Injectable()
export class OutboxPrescriptionCopyEmailSender implements PrescriptionCopyEmailSender {
  constructor(
    private readonly outbox: EmailOutbox,
    private readonly tenantContext: TenantContextService,
  ) {}

  assertCanSend(to: string): Promise<void> {
    return withEmailQuotaAs429(() =>
      this.outbox.assertWithinQuota(
        tenantIdOf(this.tenantContext),
        to,
        'prescription-copy',
      ),
    );
  }

  async prepare(input: {
    to: string;
    referenceId: string;
    locale: EmailLocale;
    vars: PrescriptionCopyEmailVars;
  }): Promise<PreparedEmail> {
    const mail = await this.outbox.prepareInTx({
      tenantId: tenantIdOf(this.tenantContext),
      to: input.to,
      template: 'prescription-copy',
      vars: input.vars,
      locale: input.locale,
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
export interface PrescriptionCopySent {
  channel: PrescriptionCopyChannel;
  sentAt: Date;
  expiresAt: Date;
  /** «a***@…» o «••• 4567»: nunca el contacto entero. */
  destinationMasked: string;
  /** Va al responsable de un menor. */
  recipientKind: 'PATIENT' | 'RESPONSIBLE';
  /**
   * Solo por WhatsApp: el enlace (una vez: la API guarda su hash), el número
   * para `wa.me` y el mensaje prellenado (clínica y enlace, nada clínico).
   */
  whatsapp: { phone: string; text: string; url: string } | null;
}

/**
 * «Enviar al paciente» (DX-468): crea el enlace caducable de la copia de una
 * receta EMITIDA (el anterior deja de servir en la misma transacción) y lo
 * envía por email (outbox, en el idioma del paciente, DX-497) o devuelve la
 * URL y el texto para que la web abra `wa.me`. Mismo criterio de acceso que
 * imprimirla: roles clínicos de la ruta, 404 de otra clínica y 403 si la sede
 * de la receta no está permitida al usuario (SEC-045). Un menor la recibe por
 * su responsable registrado.
 */
@Injectable()
export class SendPrescriptionCopyUseCase {
  constructor(
    @Inject(PRESCRIPTION_COPY_REPOSITORY)
    private readonly repo: Pick<
      PrescriptionCopyRepository,
      'loadTarget' | 'issueLink'
    >,
    @Inject(PRESCRIPTION_COPY_EMAIL_SENDER)
    private readonly email: PrescriptionCopyEmailSender,
    @Inject(TenantLinkBaseService)
    private readonly linkBase: Pick<TenantLinkBaseService, 'forTenant'>,
    @Inject(TenantContextService)
    private readonly tenantContext: Pick<
      TenantContextService,
      'getTenantId' | 'assertLocationAllowed'
    >,
    @Inject(PRESCRIPTION_COPY_CONFIG)
    private readonly config: PrescriptionCopyConfig,
    @Inject(PRESCRIPTION_CLOCK) private readonly clock: PrescriptionClock,
  ) {}

  async execute(
    prescriptionId: string,
    channel: PrescriptionCopyChannel,
    userId: string,
    requestHost?: string,
  ): Promise<PrescriptionCopySent> {
    const target = await this.repo.loadTarget(prescriptionId);
    if (!target) throw new NotFoundException(PRESCRIPTION_NOT_FOUND_MESSAGE);
    // SEC-045: una receta de una sede no permitida al usuario es 403 antes
    // de mirar nada más (como «Reenviar copia» del PDF firmado).
    this.tenantContext.assertLocationAllowed(target.location.id);
    if (target.status !== 'ISSUED') {
      throw new ConflictException(PRESCRIPTION_COPY_VOIDED_MESSAGE);
    }
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
    if (!recipient.ok) throw new UnprocessableEntityException(recipient.reason);
    // Formato de la sede para la caducidad (nunca otro formato: 409).
    const format = requireLocationFormat(target.location);
    if (channel === 'EMAIL') {
      await this.email.assertCanSend(recipient.destination);
    }
    const base = await this.linkBase.forTenant(
      tenantIdOf(this.tenantContext),
      requestHost,
    );
    if (!base) {
      throw new ConflictException(PRESCRIPTION_COPY_NO_LINK_HOST_MESSAGE);
    }

    const expiresAt = prescriptionCopyExpiresAt(now, this.config.ttlDays);
    const token = generatePublicLinkToken();
    const url = buildPrescriptionCopyUrl(base, token);
    const expiresAtLabel = format.date(expiresAt, timeZone);
    // DX-497: el idioma del paciente si hay catálogo; si no, el de la clínica.
    const { language } = resolveCatalogLanguage(
      target.patient.preferredLanguage,
      EMAIL_LOCALES,
      DEFAULT_EMAIL_LOCALE,
    );
    const linkId = randomUUID();
    const mail =
      channel === 'EMAIL'
        ? await this.email.prepare({
            to: recipient.destination,
            referenceId: linkId,
            locale: language,
            vars: {
              recipientFirstName: recipient.greetingName,
              patientFirstName: recipient.patientFirstName,
              clinicName: target.clinicName,
              url,
              expiresAtLabel,
            },
          })
        : null;
    const outcome = await this.repo.issueLink({
      id: linkId,
      prescriptionId: target.prescriptionId,
      patientId: target.patientId,
      channel,
      destinationMasked: recipient.destinationMasked,
      tokenHash: hashPublicLinkToken(token),
      expiresAt,
      createdById: userId,
      now,
      enqueue: mail
        ? async (tx) => {
            await mail.insert(tx);
          }
        : undefined,
    });
    if (outcome.kind === 'NOT_FOUND') {
      throw new NotFoundException(PRESCRIPTION_NOT_FOUND_MESSAGE);
    }
    if (outcome.kind === 'VOIDED') {
      throw new ConflictException(PRESCRIPTION_COPY_VOIDED_MESSAGE);
    }
    mail?.kick();
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
              text: PRESCRIPTION_COPY_CATALOG[language].whatsapp({
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

/** Marca de la clínica del host para la cabecera de la página pública. */
export interface PublicClinicBranding {
  name: string;
  primaryColor: string | null;
  logoUrl: string | null;
}

/**
 * Lo que ve quien abre el enlace válido:
 * - `AVAILABLE`: la receta emitida entera (la misma que se imprime, sin las
 *   notas internas de seguridad), con el QR de verificación de DX-467 y el
 *   pie de la clínica.
 * - `VOIDED`: «Esta receta fue anulada»; ni la receta ni nada que descargar.
 * - `UNVERIFIABLE`: la huella no casa con el contenido: no se muestra.
 */
export type PublicPrescriptionCopyView =
  | {
      status: 'AVAILABLE';
      clinic: PublicClinicBranding | null;
      expiresAt: Date;
      footer: string;
      prescription: PrescriptionDocument;
    }
  | {
      status: 'VOIDED';
      clinic: PublicClinicBranding | null;
      expiresAt: Date;
      voidedAt: Date | null;
      locationFormat: PrescriptionDocument['locationFormat'];
    }
  | {
      status: 'UNVERIFIABLE';
      clinic: PublicClinicBranding | null;
      expiresAt: Date;
    };

function linkExpired(): GoneException {
  return new GoneException({
    statusCode: HttpStatus.GONE,
    error: 'Gone',
    code: PRESCRIPTION_COPY_EXPIRED_CODE,
    message: PRESCRIPTION_COPY_EXPIRED_MESSAGE,
  });
}

/**
 * Abrir la copia (`GET /public/prescription-copies/:token`). Sin sesión: la
 * clínica sale SOLO del host (DX-207) y todo va bajo su RLS. Los datos
 * clínicos solo salen tras validar el token. Inventado, mal formado, de otra
 * clínica, invalidado al reenviar o del paciente archivado: el mismo 404;
 * caducado: 410 con su código. Cada apertura válida queda auditada (VIEW de
 * PRESCRIPTION, origen PUBLIC_LINK, PRESCRIPTION_COPY_OPENED), también la de
 * una receta anulada.
 */
@Injectable()
export class GetPublicPrescriptionCopyUseCase {
  constructor(
    @Inject(PRESCRIPTION_COPY_REPOSITORY)
    private readonly repo: Pick<
      PrescriptionCopyRepository,
      'findLinkByTokenHash' | 'recordOpened' | 'findClinicBranding'
    >,
    @Inject(PRESCRIPTION_REPOSITORY)
    private readonly prescriptions: Pick<PrescriptionRepository, 'findById'>,
    @Inject(PRESCRIPTION_SETTINGS_REPOSITORY)
    private readonly settings: Pick<PrescriptionSettingsRepository, 'get'>,
    @Inject(TenantContextService)
    private readonly tenantContext: Pick<TenantContextService, 'getTenantId'>,
    @Inject(PRESCRIPTION_CLOCK) private readonly clock: PrescriptionClock,
  ) {}

  async execute(
    token: string,
    meta: AuditRequestMeta,
  ): Promise<PublicPrescriptionCopyView> {
    if (
      !this.tenantContext.getTenantId() ||
      !isWellFormedPublicLinkToken(token)
    ) {
      throw new NotFoundException(PRESCRIPTION_COPY_NOT_FOUND_MESSAGE);
    }
    const link = await this.repo.findLinkByTokenHash(
      hashPublicLinkToken(token),
    );
    if (!link) throw new NotFoundException(PRESCRIPTION_COPY_NOT_FOUND_MESSAGE);
    const state = prescriptionCopyLinkState(link, this.clock());
    if (state === 'GONE') {
      throw new NotFoundException(PRESCRIPTION_COPY_NOT_FOUND_MESSAGE);
    }
    if (state === 'EXPIRED') throw linkExpired();

    const rx = await this.prescriptions.findById(link.prescriptionId);
    if (!rx) throw new NotFoundException(PRESCRIPTION_COPY_NOT_FOUND_MESSAGE);
    await this.repo.recordOpened({
      prescriptionId: rx.id,
      locationId: rx.locationId,
      meta,
    });
    const clinic = await this.repo.findClinicBranding();
    if (rx.status === 'VOIDED') {
      return {
        status: 'VOIDED',
        clinic,
        expiresAt: link.expiresAt,
        voidedAt: rx.voidedAt,
        locationFormat: rx.locationFormat,
      };
    }
    // Una fila que ni se puede sellar con su formato tampoco valida (null).
    if (expectedPrescriptionHash(rx) !== rx.contentHash) {
      return { status: 'UNVERIFIABLE', clinic, expiresAt: link.expiresAt };
    }
    const { patientCopyFooter } = await this.settings.get();
    return {
      status: 'AVAILABLE',
      clinic,
      expiresAt: link.expiresAt,
      footer: prescriptionCopyFooter(patientCopyFooter),
      prescription: { ...rx, integrityOk: true },
    };
  }
}
