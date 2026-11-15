import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
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
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { TenantLinkBaseService } from '../../../shared/tenancy/tenant-link-base.service';
import { civilDateIn } from '../../../shared/time/civil-day';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import {
  DEFAULT_EMAIL_LOCALE,
  EMAIL_LOCALES,
} from '../../notifications/email/domain/email-message';
import { resolvePrescriptionCopyRecipient } from '../../prescriptions/domain/prescription-copy-recipient';
import {
  CERTIFICATE_COPY_CONFIG,
  CERTIFICATE_COPY_EXPIRED_CODE,
  CERTIFICATE_COPY_EXPIRED_MESSAGE,
  CERTIFICATE_COPY_NOT_FOUND_MESSAGE,
  CERTIFICATE_COPY_NO_LINK_HOST_MESSAGE,
  CERTIFICATE_COPY_VOIDED_MESSAGE,
  buildCertificateCopyUrl,
  certificateCopyExpiresAt,
  certificateCopyLinkState,
  certificateRecipientMessage,
  certificateWhatsAppText,
  type CertificateCopyConfig,
} from '../domain/certificate-copy-link';
import {
  CERTIFICATE_MESSAGES,
  canSeeDiagnosis,
} from '../domain/certificate-rules';
import {
  buildCertificatePdfModel,
  certificateFileName,
  type PatientCertificate,
} from '../domain/patient-certificate';
import {
  PATIENT_CERTIFICATE_REPOSITORY,
  type PatientCertificateRepository,
} from '../domain/ports/patient-certificate-repository.port';
import {
  CERTIFICATE_PDF_RENDERER,
  type CertificatePdfRenderer,
} from '../infrastructure/certificate-pdf.renderer';
import {
  CERTIFICATE_COPY_REPOSITORY,
  type PrismaCertificateCopyRepository,
  type PublicClinicBranding,
} from '../infrastructure/prisma-certificate-copy.repository';
import type {
  CertificateActor,
  CertificatePdf,
} from './patient-certificates.use-cases';

export const CERTIFICATE_COPY_CLOCK = Symbol('CERTIFICATE_COPY_CLOCK');
export type CertificateCopyClock = () => Date;

/** Respuesta de «Enviar por WhatsApp». */
export interface CertificateCopySent {
  sentAt: Date;
  expiresAt: Date;
  /** «••• 4567»: nunca el número entero. */
  destinationMasked: string;
  recipientKind: 'PATIENT' | 'RESPONSIBLE';
  /** El enlace (una vez: la API guarda su hash), el número y el texto. */
  whatsapp: { phone: string; text: string; url: string };
}

type CopyRepo = Pick<
  PrismaCertificateCopyRepository,
  | 'loadTarget'
  | 'issueLink'
  | 'findLinkByTokenHash'
  | 'recordPublicAccess'
  | 'findClinicBranding'
>;

/**
 * «Enviar por WhatsApp» (DX-306): crea el enlace caducable de la copia de un
 * certificado VIGENTE (el anterior deja de servir en la misma transacción) y
 * devuelve el número, el enlace y el texto para que la web abra `wa.me`.
 * Mismo acceso que imprimirlo: los 4 roles, 404 de otra clínica, 403 si la
 * sede no está permitida o si quien envía no puede ver el diagnóstico que el
 * certificado lleva. Un menor la recibe por su responsable que recibe avisos
 * (criterio de DX-468). Auditado por la ruta: SEND · CERTIFICATE_COPY_SENT.
 */
@Injectable()
export class SendCertificateCopyUseCase {
  constructor(
    @Inject(CERTIFICATE_COPY_REPOSITORY) private readonly copies: CopyRepo,
    @Inject(PATIENT_CERTIFICATE_REPOSITORY)
    private readonly certificates: Pick<PatientCertificateRepository, 'get'>,
    @Inject(TenantLinkBaseService)
    private readonly linkBase: Pick<TenantLinkBaseService, 'forTenant'>,
    @Inject(TenantContextService)
    private readonly tenantContext: Pick<
      TenantContextService,
      'getTenantId' | 'assertLocationAllowed'
    >,
    @Inject(CERTIFICATE_COPY_CONFIG)
    private readonly config: CertificateCopyConfig,
    @Inject(CERTIFICATE_COPY_CLOCK)
    private readonly clock: CertificateCopyClock,
  ) {}

  async execute(
    patientId: string,
    certificateId: string,
    actor: CertificateActor,
    requestHost?: string,
  ): Promise<CertificateCopySent> {
    const target = await this.copies.loadTarget(patientId, certificateId);
    if (!target) throw new NotFoundException(CERTIFICATE_MESSAGES.notFound);
    this.tenantContext.assertLocationAllowed(target.locationId);
    const certificate = await this.certificates.get(patientId, certificateId);
    if (!certificate)
      throw new NotFoundException(CERTIFICATE_MESSAGES.notFound);
    if (
      certificate.diagnosis !== null &&
      !canSeeDiagnosis(actor, certificate)
    ) {
      throw new ForbiddenException(CERTIFICATE_MESSAGES.diagnosisHidden);
    }
    if (target.voided) {
      throw new ConflictException(CERTIFICATE_COPY_VOIDED_MESSAGE);
    }
    const now = this.clock();
    const timeZone = requireLocationTimeZone(target.location);
    const recipient = resolvePrescriptionCopyRecipient({
      channel: 'WHATSAPP',
      patient: target.patient,
      responsibles: target.responsibles,
      majorityAge: target.majorityAge,
      today: civilDateIn(now, timeZone),
      phoneRegion: phoneRegionOrNull(target.location.phoneRegion),
    });
    if (!recipient.ok) {
      throw new UnprocessableEntityException(
        certificateRecipientMessage(recipient.reason),
      );
    }
    const format = requireLocationFormat(target.location);
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    const base = await this.linkBase.forTenant(tenantId, requestHost);
    if (!base)
      throw new ConflictException(CERTIFICATE_COPY_NO_LINK_HOST_MESSAGE);

    const expiresAt = certificateCopyExpiresAt(now, this.config.ttlDays);
    const token = generatePublicLinkToken();
    const url = buildCertificateCopyUrl(base, token);
    const outcome = await this.copies.issueLink({
      id: randomUUID(),
      certificateId,
      patientId,
      destinationMasked: recipient.destinationMasked,
      tokenHash: hashPublicLinkToken(token),
      expiresAt,
      createdById: actor.userId,
      now,
    });
    if (outcome === 'NOT_FOUND') {
      throw new NotFoundException(CERTIFICATE_MESSAGES.notFound);
    }
    if (outcome === 'VOIDED') {
      throw new ConflictException(CERTIFICATE_COPY_VOIDED_MESSAGE);
    }
    // DX-497: el idioma del paciente si hay texto; si no, español.
    const { language } = resolveCatalogLanguage(
      target.patient.preferredLanguage,
      EMAIL_LOCALES,
      DEFAULT_EMAIL_LOCALE,
    );
    return {
      sentAt: now,
      expiresAt,
      destinationMasked: recipient.destinationMasked,
      recipientKind: recipient.kind,
      whatsapp: {
        phone: recipient.destination,
        url,
        text: certificateWhatsAppText({
          language,
          kind: certificate.kind,
          name: recipient.greetingName,
          clinic: target.clinicName,
          patient: recipient.patientFirstName,
          expiresAtLabel: format.date(expiresAt, timeZone),
          url,
        }),
      },
    };
  }
}

/**
 * Lo que ve quien abre el enlace válido:
 * - `AVAILABLE`: el certificado (lo mismo que imprime el PDF) y su descarga.
 * - `VOIDED`: «Este certificado fue anulado»; ni el contenido ni la descarga.
 */
export type PublicCertificateCopyView =
  | {
      status: 'AVAILABLE';
      clinic: PublicClinicBranding | null;
      expiresAt: Date;
      certificate: PatientCertificate;
    }
  | {
      status: 'VOIDED';
      clinic: PublicClinicBranding | null;
      expiresAt: Date;
      voidedAt: Date | null;
      certificate: PatientCertificate;
    };

function linkExpired(): GoneException {
  return new GoneException({
    statusCode: HttpStatus.GONE,
    error: 'Gone',
    code: CERTIFICATE_COPY_EXPIRED_CODE,
    message: CERTIFICATE_COPY_EXPIRED_MESSAGE,
  });
}

/**
 * Abrir la copia y descargar su PDF (`/public/certificate-copies/:token`).
 * Sin sesión: la clínica sale SOLO del host (DX-207) y todo va bajo su RLS.
 * Inventado, mal formado, de otra clínica, invalidado o del paciente
 * archivado: el mismo 404; caducado: 410 con su código. Cada apertura (VIEW)
 * y cada descarga (EXPORT) quedan auditadas sin usuario, origen PUBLIC_LINK.
 */
@Injectable()
export class GetPublicCertificateCopyUseCase {
  constructor(
    @Inject(CERTIFICATE_COPY_REPOSITORY) private readonly copies: CopyRepo,
    @Inject(PATIENT_CERTIFICATE_REPOSITORY)
    private readonly certificates: Pick<PatientCertificateRepository, 'get'>,
    @Inject(CERTIFICATE_PDF_RENDERER)
    private readonly renderer: CertificatePdfRenderer,
    @Inject(TenantContextService)
    private readonly tenantContext: Pick<TenantContextService, 'getTenantId'>,
    @Inject(CERTIFICATE_COPY_CLOCK)
    private readonly clock: CertificateCopyClock,
  ) {}

  private async resolve(token: string): Promise<{
    certificate: PatientCertificate;
    expiresAt: Date;
  }> {
    if (
      !this.tenantContext.getTenantId() ||
      !isWellFormedPublicLinkToken(token)
    ) {
      throw new NotFoundException(CERTIFICATE_COPY_NOT_FOUND_MESSAGE);
    }
    const link = await this.copies.findLinkByTokenHash(
      hashPublicLinkToken(token),
    );
    if (!link) throw new NotFoundException(CERTIFICATE_COPY_NOT_FOUND_MESSAGE);
    const state = certificateCopyLinkState(link, this.clock());
    if (state === 'GONE') {
      throw new NotFoundException(CERTIFICATE_COPY_NOT_FOUND_MESSAGE);
    }
    if (state === 'EXPIRED') throw linkExpired();
    const certificate = await this.certificates.get(
      link.patientId,
      link.certificateId,
    );
    if (!certificate) {
      throw new NotFoundException(CERTIFICATE_COPY_NOT_FOUND_MESSAGE);
    }
    return { certificate, expiresAt: link.expiresAt };
  }

  async view(
    token: string,
    meta: AuditRequestMeta,
  ): Promise<PublicCertificateCopyView> {
    const { certificate, expiresAt } = await this.resolve(token);
    await this.copies.recordPublicAccess({
      action: 'VIEW',
      certificateId: certificate.id,
      patientId: certificate.patientId,
      locationId: certificate.locationId,
      meta,
    });
    const clinic = await this.copies.findClinicBranding();
    if (certificate.voidedAt !== null) {
      return {
        status: 'VOIDED',
        clinic,
        expiresAt,
        voidedAt: certificate.voidedAt,
        certificate,
      };
    }
    return { status: 'AVAILABLE', clinic, expiresAt, certificate };
  }

  async pdf(token: string, meta: AuditRequestMeta): Promise<CertificatePdf> {
    const { certificate } = await this.resolve(token);
    if (certificate.voidedAt !== null) {
      throw new ConflictException(
        'Este certificado fue anulado: no se puede descargar.',
      );
    }
    const pdf = await this.renderer.render(
      buildCertificatePdfModel(certificate),
    );
    await this.copies.recordPublicAccess({
      action: 'EXPORT',
      certificateId: certificate.id,
      patientId: certificate.patientId,
      locationId: certificate.locationId,
      meta,
    });
    return {
      pdf,
      fileName: certificateFileName(
        certificate.kind,
        certificate.number,
        false,
      ),
    };
  }
}
