import { Injectable } from '@nestjs/common';
import { lockLivePatientOrConflict } from '../../../../shared/patients/lock-live-patient';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { withClinicLogoUrl } from '../../../../shared/storage/clinic-logo-url';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import { loadTenantMajorityAge } from '../../../patients/infrastructure/notices/notice-context';
import { PRESCRIPTION_COPY_OPENED_REASON } from '../../domain/prescription-copy-link';
import type { PrescriptionCopyResponsible } from '../../domain/prescription-copy-recipient';
import type {
  IssuePrescriptionCopyLinkInput,
  IssuePrescriptionCopyLinkOutcome,
  PrescriptionCopyLinkRow,
  PrescriptionCopyRepository,
  PrescriptionCopyTarget,
} from '../../domain/ports/prescription-copy-repository.port';

/**
 * Copia de la receta para el paciente (DX-468) en Postgres, todo bajo
 * `runWithTenant` (RLS FORCE): una receta, un paciente o un enlace de otra
 * clínica no existen. `tenants` no tiene RLS: se acota por el tenant del
 * contexto.
 */
@Injectable()
export class PrismaPrescriptionCopyRepository implements PrescriptionCopyRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  loadTarget(prescriptionId: string): Promise<PrescriptionCopyTarget | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const rx = await tx.prescription.findFirst({
        // A un paciente archivado no se le escribe (DX-461).
        where: { id: prescriptionId, patient: { deletedAt: null } },
        select: {
          id: true,
          patientId: true,
          status: true,
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
      if (!rx) return null;
      const [rows, majorityAge, tenant] = await Promise.all([
        tx.patientResponsibleParty.findMany({
          where: { patientId: rx.patientId, deletedAt: null },
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
        prescriptionId: rx.id,
        patientId: rx.patientId,
        status: rx.status,
        clinicName: tenant?.name ?? '',
        location: {
          id: rx.location.id,
          timeZone: rx.location.timeZone,
          locale: rx.location.locale,
          hourCycle: rx.location.hourCycle,
          phoneRegion: rx.location.defaultPhoneRegion,
        },
        patient: rx.patient,
        responsibles,
        majorityAge,
      };
    });
  }

  async issueLink(
    input: IssuePrescriptionCopyLinkInput,
  ): Promise<IssuePrescriptionCopyLinkOutcome> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // DX-476: primero el paciente vivo (el orden de archivar), 409 si ya
      // está archivado: nunca un enlace vivo ni un mensaje a un archivado.
      await lockLivePatientOrConflict(tx, input.patientId);
      // Serializa los envíos de la misma receta (dos «Enviar» a la vez) y
      // la anulación: sin este candado los dos invalidan el mismo enlace y el
      // segundo INSERT choca con el índice parcial (500), o la copia sale de
      // una receta que se acaba de anular.
      const [rx] = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status"::text AS "status" FROM "prescriptions"
         WHERE "id" = ${input.prescriptionId}::uuid
           AND "patientId" = ${input.patientId}::uuid
         FOR NO KEY UPDATE`;
      if (!rx) return { kind: 'NOT_FOUND' };
      if (rx.status !== 'ISSUED') return { kind: 'VOIDED' };
      // El anterior deja de servir en la MISMA transacción (y el índice
      // parcial prescription_copy_links_live_key impide dos vivos).
      await tx.prescriptionCopyLink.updateMany({
        where: { prescriptionId: input.prescriptionId, revokedAt: null },
        data: { revokedAt: input.now },
      });
      await tx.prescriptionCopyLink.create({
        data: {
          id: input.id,
          tenantId,
          patientId: input.patientId,
          prescriptionId: input.prescriptionId,
          channel: input.channel,
          destinationMasked: input.destinationMasked,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          createdById: input.createdById,
          createdAt: input.now,
        },
        select: { id: true },
      });
      // DX-463: el email del enlace nuevo, en esta misma transacción.
      await input.enqueue?.(tx);
      return { kind: 'ISSUED' };
    });
  }

  findLinkByTokenHash(
    tokenHash: string,
  ): Promise<PrescriptionCopyLinkRow | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.prescriptionCopyLink.findFirst({
        // DX-461: el enlace de un paciente archivado no existe para la ruta
        // pública (mismo 404 que uno invalidado).
        where: { tokenHash, patient: { deletedAt: null } },
        select: {
          id: true,
          prescriptionId: true,
          patientId: true,
          expiresAt: true,
          revokedAt: true,
        },
      }),
    );
  }

  async recordOpened(input: {
    prescriptionId: string;
    locationId: string;
    meta: AuditRequestMeta;
  }): Promise<void> {
    const tenantId = this.tenantId();
    await this.prisma.runWithTenant((tx) =>
      writeAuditEvent(tx, {
        tenantId,
        locationId: input.locationId,
        actor: { kind: 'public' },
        action: 'VIEW',
        resourceType: 'PRESCRIPTION',
        resourceId: input.prescriptionId,
        patient: { kind: 'prescription', id: input.prescriptionId },
        requestId: input.meta.requestId,
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
        metadata: {
          origin: 'PUBLIC_LINK',
          reason: PRESCRIPTION_COPY_OPENED_REASON,
        },
      }),
    );
  }

  findClinicBranding() {
    // `tenants` no tiene RLS: se lee por el id ya resuelto desde el host.
    return this.prisma.tenant
      .findFirst({
        where: { id: this.tenantId(), deletedAt: null },
        select: { name: true, primaryColor: true, logoKey: true },
      })
      .then((row) => withClinicLogoUrl(row));
  }
}
