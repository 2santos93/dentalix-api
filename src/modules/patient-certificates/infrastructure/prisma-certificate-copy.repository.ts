import { Injectable } from '@nestjs/common';
import type { ContactChannel } from '@prisma/client';
import { lockLivePatientOrConflict } from '../../../shared/patients/lock-live-patient';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { withClinicLogoUrl } from '../../../shared/storage/clinic-logo-url';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { loadTenantMajorityAge } from '../../patients/infrastructure/notices/notice-context';
import type { PrescriptionCopyResponsible } from '../../prescriptions/domain/prescription-copy-recipient';
import {
  CERTIFICATE_COPY_DOWNLOADED_REASON,
  CERTIFICATE_COPY_OPENED_REASON,
} from '../domain/certificate-copy-link';

export const CERTIFICATE_COPY_REPOSITORY = Symbol(
  'CERTIFICATE_COPY_REPOSITORY',
);

/** A quién y desde dónde se envía la copia de un certificado. */
export interface CertificateCopyTarget {
  certificateId: string;
  patientId: string;
  locationId: string;
  voided: boolean;
  clinicName: string;
  location: {
    id: string;
    timeZone: string | null;
    locale: string | null;
    hourCycle: string | null;
    phoneRegion: string | null;
  };
  patient: {
    firstName: string;
    birthDate: Date | null;
    email: string | null;
    phone: string | null;
    reminderOptOutAt: Date | null;
    contactChannel: ContactChannel;
    preferredLanguage: string | null;
  };
  responsibles: PrescriptionCopyResponsible[];
  majorityAge: number;
}

export interface IssueCertificateCopyLinkInput {
  id: string;
  certificateId: string;
  patientId: string;
  destinationMasked: string;
  tokenHash: string;
  expiresAt: Date;
  createdById: string;
  now: Date;
}

export interface CertificateCopyLinkRow {
  certificateId: string;
  patientId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface PublicClinicBranding {
  name: string;
  primaryColor: string | null;
  logoUrl: string | null;
}

/**
 * Copia del certificado para el paciente (DX-306) en Postgres, todo bajo
 * `runWithTenant` (RLS FORCE): un certificado, un paciente o un enlace de otra
 * clínica no existen. `tenants` no tiene RLS: se acota por el tenant del
 * contexto. Mismo molde que la copia de la receta (DX-468).
 */
@Injectable()
export class PrismaCertificateCopyRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  loadTarget(
    patientId: string,
    certificateId: string,
  ): Promise<CertificateCopyTarget | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const cert = await tx.patientCertificate.findFirst({
        // A un paciente archivado no se le escribe (DX-461).
        where: { id: certificateId, patientId, patient: { deletedAt: null } },
        select: {
          id: true,
          patientId: true,
          locationId: true,
          voidedAt: true,
          location: {
            select: {
              id: true,
              timeZone: true,
              locale: true,
              hourCycle: true,
              defaultPhoneRegion: true,
            },
          },
          patient: {
            select: {
              firstName: true,
              birthDate: true,
              email: true,
              phone: true,
              reminderOptOutAt: true,
              contactChannel: true,
              preferredLanguage: true,
            },
          },
        },
      });
      if (!cert) return null;
      const [rows, majorityAge, tenant] = await Promise.all([
        tx.patientResponsibleParty.findMany({
          where: { patientId, deletedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            isPayer: true,
            receivesNotices: true,
            responsiblePatient: {
              select: {
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                deletedAt: true,
              },
            },
          },
        }),
        loadTenantMajorityAge(tx, tenantId),
        tx.tenant.findFirst({
          where: { id: tenantId },
          select: { name: true },
        }),
      ]);
      // Como loadNoticeResponsibles (DX-203): un paciente responsable
      // archivado no cuenta; su contacto es el de su ficha.
      const responsibles: PrescriptionCopyResponsible[] = [];
      for (const row of rows) {
        const p = row.responsiblePatient;
        if (p?.deletedAt) continue;
        responsibles.push({
          id: row.id,
          name: p ? `${p.firstName} ${p.lastName}` : (row.fullName ?? ''),
          email: p ? p.email : row.email,
          phone: p ? p.phone : row.phone,
          isPayer: row.isPayer,
          receivesNotices: row.receivesNotices,
        });
      }
      return {
        certificateId: cert.id,
        patientId: cert.patientId,
        locationId: cert.locationId,
        voided: cert.voidedAt !== null,
        clinicName: tenant?.name ?? '',
        location: {
          id: cert.location.id,
          timeZone: cert.location.timeZone,
          locale: cert.location.locale,
          hourCycle: cert.location.hourCycle,
          phoneRegion: cert.location.defaultPhoneRegion,
        },
        patient: cert.patient,
        responsibles,
        majorityAge,
      };
    });
  }

  issueLink(
    input: IssueCertificateCopyLinkInput,
  ): Promise<'ISSUED' | 'NOT_FOUND' | 'VOIDED'> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // DX-476: primero el paciente vivo (el orden de archivar), 409 si ya
      // está archivado: nunca un enlace vivo a un archivado.
      await lockLivePatientOrConflict(tx, input.patientId);
      // Serializa los envíos del mismo certificado y la anulación.
      const [cert] = await tx.$queryRaw<{ voided: boolean }[]>`
        SELECT ("voidedAt" IS NOT NULL) AS "voided" FROM "patient_certificates"
         WHERE "id" = ${input.certificateId}::uuid
           AND "patientId" = ${input.patientId}::uuid
         FOR NO KEY UPDATE`;
      if (!cert) return 'NOT_FOUND';
      if (cert.voided) return 'VOIDED';
      // El anterior deja de servir en la MISMA transacción (y el índice
      // parcial impide dos vivos).
      await tx.patientCertificateCopyLink.updateMany({
        where: { certificateId: input.certificateId, revokedAt: null },
        data: { revokedAt: input.now },
      });
      await tx.patientCertificateCopyLink.create({
        data: {
          id: input.id,
          tenantId,
          patientId: input.patientId,
          certificateId: input.certificateId,
          destinationMasked: input.destinationMasked,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          createdById: input.createdById,
          createdAt: input.now,
        },
        select: { id: true },
      });
      return 'ISSUED';
    });
  }

  findLinkByTokenHash(
    tokenHash: string,
  ): Promise<CertificateCopyLinkRow | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.patientCertificateCopyLink.findFirst({
        // DX-461: el enlace de un paciente archivado no existe para la ruta
        // pública (mismo 404 que uno invalidado).
        where: { tokenHash, patient: { deletedAt: null } },
        select: {
          certificateId: true,
          patientId: true,
          expiresAt: true,
          revokedAt: true,
        },
      }),
    );
  }

  /** Apertura (VIEW) o descarga (EXPORT) pública, sin usuario. Solo ids. */
  async recordPublicAccess(input: {
    action: 'VIEW' | 'EXPORT';
    certificateId: string;
    patientId: string;
    locationId: string;
    meta: AuditRequestMeta;
  }): Promise<void> {
    const tenantId = this.tenantId();
    await this.prisma.runWithTenant((tx) =>
      writeAuditEvent(tx, {
        tenantId,
        locationId: input.locationId,
        actor: { kind: 'public' },
        action: input.action,
        resourceType: 'PATIENT_CERTIFICATE',
        resourceId: input.certificateId,
        patient: { kind: 'patient', id: input.patientId },
        requestId: input.meta.requestId,
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
        metadata: {
          origin: 'PUBLIC_LINK',
          reason:
            input.action === 'VIEW'
              ? CERTIFICATE_COPY_OPENED_REASON
              : CERTIFICATE_COPY_DOWNLOADED_REASON,
        },
      }),
    );
  }

  findClinicBranding(): Promise<PublicClinicBranding | null> {
    // `tenants` no tiene RLS: se lee por el id ya resuelto desde el host.
    return this.prisma.tenant
      .findFirst({
        where: { id: this.tenantId(), deletedAt: null },
        select: { name: true, primaryColor: true, logoKey: true },
      })
      .then((row) => withClinicLogoUrl(row));
  }
}
