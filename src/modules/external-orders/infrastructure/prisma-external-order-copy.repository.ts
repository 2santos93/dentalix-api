import { Injectable } from '@nestjs/common';
import type { ContactChannel, Prisma } from '@prisma/client';
import { lockLivePatientOrConflict } from '../../../shared/patients/lock-live-patient';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { withClinicLogoUrl } from '../../../shared/storage/clinic-logo-url';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { loadTenantMajorityAge } from '../../patients/infrastructure/notices/notice-context';
import type { PrescriptionCopyResponsible } from '../../prescriptions/domain/prescription-copy-recipient';
import type { ExternalOrder } from '../domain/external-order';
import {
  EXTERNAL_ORDER_COPY_DOWNLOADED_REASON,
  EXTERNAL_ORDER_COPY_OPENED_REASON,
  type ExternalOrderCopyChannel,
} from '../domain/external-order-copy-link';
import type { ExternalOrderStatus } from '../domain/external-order-rules';
import { toExternalOrder } from './prisma-external-order.repository';

export const EXTERNAL_ORDER_COPY_REPOSITORY = Symbol(
  'EXTERNAL_ORDER_COPY_REPOSITORY',
);

/** A quién y desde dónde se envía la copia de una orden. */
export interface ExternalOrderCopyTarget {
  orderId: string;
  patientId: string;
  locationId: string;
  status: ExternalOrderStatus;
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

export interface IssueExternalOrderCopyLinkInput {
  id: string;
  orderId: string;
  patientId: string;
  channel: ExternalOrderCopyChannel;
  destinationMasked: string;
  tokenHash: string;
  expiresAt: Date;
  createdById: string;
  now: Date;
  /** Encola el email en la MISMA transacción que crea el enlace. */
  enqueue?: (tx: Prisma.TransactionClient) => Promise<void>;
}

export interface ExternalOrderCopyLinkRow {
  id: string;
  orderId: string;
  patientId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

export interface PublicClinicBranding {
  name: string;
  primaryColor: string | null;
  logoUrl: string | null;
}

export type ConsumeCopyOutcome =
  | { kind: 'DOWNLOADED'; order: ExternalOrder; pdf: Buffer }
  | { kind: 'USED' }
  | { kind: 'GONE' };

/**
 * Copia de la orden para el paciente (DX-572) en Postgres, todo bajo
 * `runWithTenant` (RLS FORCE): una orden, un paciente o un enlace de otra
 * clínica no existen. `tenants` no tiene RLS: se acota por el tenant del
 * contexto. Mismo molde que la copia del certificado (DX-306) y la del PDF
 * firmado (DX-443, de un solo uso).
 */
@Injectable()
export class PrismaExternalOrderCopyRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  loadTarget(orderId: string): Promise<ExternalOrderCopyTarget | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const order = await tx.externalOrder.findFirst({
        // A un paciente archivado no se le escribe (DX-461).
        where: { id: orderId, patient: { deletedAt: null } },
        select: {
          id: true,
          patientId: true,
          locationId: true,
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
      if (!order) return null;
      const [rows, majorityAge, tenant] = await Promise.all([
        tx.patientResponsibleParty.findMany({
          where: { patientId: order.patientId, deletedAt: null },
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
        orderId: order.id,
        patientId: order.patientId,
        locationId: order.locationId,
        status: order.status,
        clinicName: tenant?.name ?? '',
        location: {
          id: order.location.id,
          timeZone: order.location.timeZone,
          locale: order.location.locale,
          hourCycle: order.location.hourCycle,
          phoneRegion: order.location.defaultPhoneRegion,
        },
        patient: order.patient,
        responsibles,
        majorityAge,
      };
    });
  }

  issueLink(
    input: IssueExternalOrderCopyLinkInput,
  ): Promise<'ISSUED' | 'NOT_FOUND' | 'VOIDED'> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // DX-476: primero el paciente vivo (el orden de archivar), 409 si ya
      // está archivado: nunca un enlace vivo a un archivado.
      await lockLivePatientOrConflict(tx, input.patientId);
      // Serializa los envíos de la misma orden y la anulación.
      const [order] = await tx.$queryRaw<{ voided: boolean }[]>`
        SELECT ("status" = 'VOIDED') AS "voided" FROM "external_orders"
         WHERE "id" = ${input.orderId}::uuid
           AND "patientId" = ${input.patientId}::uuid
         FOR NO KEY UPDATE`;
      if (!order) return 'NOT_FOUND';
      if (order.voided) return 'VOIDED';
      // El anterior deja de servir en la MISMA transacción (y el índice
      // parcial impide dos vivos).
      await tx.externalOrderCopyLink.updateMany({
        where: { orderId: input.orderId, revokedAt: null, usedAt: null },
        data: { revokedAt: input.now },
      });
      await tx.externalOrderCopyLink.create({
        data: {
          id: input.id,
          tenantId,
          patientId: input.patientId,
          orderId: input.orderId,
          channel: input.channel,
          destinationMasked: input.destinationMasked,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          createdById: input.createdById,
          createdAt: input.now,
        },
        select: { id: true },
      });
      if (input.enqueue) await input.enqueue(tx);
      return 'ISSUED';
    });
  }

  findLinkByTokenHash(
    tokenHash: string,
  ): Promise<ExternalOrderCopyLinkRow | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.externalOrderCopyLink.findFirst({
        // DX-461: el enlace de un paciente archivado no existe para la ruta
        // pública (mismo 404 que uno invalidado).
        where: { tokenHash, patient: { deletedAt: null } },
        select: {
          id: true,
          orderId: true,
          patientId: true,
          expiresAt: true,
          usedAt: true,
          revokedAt: true,
        },
      }),
    );
  }

  /** La orden de un enlace (bajo la RLS del host), o null. */
  async orderOf(orderId: string): Promise<ExternalOrder | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.externalOrder.findFirst({
        where: { id: orderId },
        include: {
          issuedBy: { select: { fullName: true } },
          voidedBy: { select: { fullName: true } },
          resultLinkedBy: { select: { fullName: true } },
        },
      });
      return row ? toExternalOrder(row) : null;
    });
  }

  /**
   * Gasta el enlace y devuelve el PDF, en UNA transacción con la fila del
   * enlace bloqueada: dos descargas a la vez, una gana y la otra ve el enlace
   * usado (410). El PDF se genera antes de marcarlo: si falla, el enlace
   * sigue sin usar. Queda auditado (EXPORT, origen PUBLIC_LINK).
   */
  consume(input: {
    linkId: string;
    now: Date;
    render: (order: ExternalOrder) => Promise<Buffer>;
    meta: AuditRequestMeta;
  }): Promise<ConsumeCopyOutcome> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const [link] = await tx.$queryRaw<
        {
          orderId: string;
          patientId: string;
          expiresAt: Date;
          usedAt: Date | null;
          revokedAt: Date | null;
        }[]
      >`
        SELECT l."orderId", l."patientId", l."expiresAt", l."usedAt", l."revokedAt"
          FROM "external_order_copy_links" l
          JOIN "patients" p ON p."tenantId" = l."tenantId" AND p."id" = l."patientId"
         WHERE l."id" = ${input.linkId}::uuid AND p."deletedAt" IS NULL
           FOR UPDATE OF l`;
      if (!link || link.revokedAt !== null) return { kind: 'GONE' };
      if (link.expiresAt.getTime() <= input.now.getTime()) {
        return { kind: 'GONE' };
      }
      if (link.usedAt !== null) return { kind: 'USED' };
      const row = await tx.externalOrder.findFirst({
        where: { id: link.orderId },
        include: {
          issuedBy: { select: { fullName: true } },
          voidedBy: { select: { fullName: true } },
          resultLinkedBy: { select: { fullName: true } },
        },
      });
      if (!row || row.status === 'VOIDED') return { kind: 'GONE' };
      const order = toExternalOrder(row);
      const pdf = await input.render(order);
      await tx.externalOrderCopyLink.update({
        where: { id: input.linkId },
        data: { usedAt: input.now },
        select: { id: true },
      });
      await writeAuditEvent(tx, {
        tenantId,
        locationId: order.locationId,
        actor: { kind: 'public' },
        action: 'EXPORT',
        resourceType: 'EXTERNAL_ORDER',
        resourceId: order.id,
        patient: { kind: 'patient', id: order.patientId },
        requestId: input.meta.requestId,
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
        metadata: {
          origin: 'PUBLIC_LINK',
          reason: EXTERNAL_ORDER_COPY_DOWNLOADED_REASON,
        },
      });
      return { kind: 'DOWNLOADED', order, pdf };
    });
  }

  /** Apertura pública (VIEW), sin usuario. Solo ids. */
  async recordPublicView(input: {
    orderId: string;
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
        action: 'VIEW',
        resourceType: 'EXTERNAL_ORDER',
        resourceId: input.orderId,
        patient: { kind: 'patient', id: input.patientId },
        requestId: input.meta.requestId,
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
        metadata: {
          origin: 'PUBLIC_LINK',
          reason: EXTERNAL_ORDER_COPY_OPENED_REASON,
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
