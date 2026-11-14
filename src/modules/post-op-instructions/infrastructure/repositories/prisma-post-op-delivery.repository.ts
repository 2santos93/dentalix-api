import {
  DOCUMENT_REGIONAL_SELECT,
  documentRegional,
} from '../../../../shared/locations/document-regional';
import {
  clinicLogoKeyToFreeze,
  clinicLogoPublicUrl,
} from '../../../../shared/storage/clinic-logo-url';
import { Injectable } from '@nestjs/common';
import {
  EmailOutboxStatus,
  EmailTemplate,
  Prisma,
  type PostOpInstructionDelivery,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { requireLocationTimeZone } from '../../../../shared/locations/location-time-zone';
import {
  loadNoticeResponsibles,
  loadMajorityReview,
  loadTenantMajorityAge,
} from '../../../patients/infrastructure/notices/notice-context';
import { performedItemsOf } from '../../../clinical-entries/infrastructure/repositories/performed-items';
import type { PostOpDelivery } from '../../domain/entities/post-op-delivery.entity';
import { PostOpDeliveryAlreadyExistsError } from '../../domain/ports/post-op-delivery-repository.port';
import type {
  CreatePostOpDeliveryRepoInput,
  PostOpAppointmentContext,
  PostOpDeliveryDocumentView,
  PostOpDeliveryRepository,
  PostOpEmailStatus,
  PostOpPublicDeliveryView,
} from '../../domain/ports/post-op-delivery-repository.port';

// Más recientes primero; `id` desempata para que el orden sea estable.
const NEWEST_FIRST = [
  { deliveredAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.PostOpInstructionDeliveryOrderByWithRelationInput[];

function toEntity(row: PostOpInstructionDelivery): PostOpDelivery {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    appointmentId: row.appointmentId,
    locationId: row.locationId,
    templateId: row.templateId,
    templateCode: row.templateCode,
    templateTitle: row.templateTitle,
    templateVersion: row.templateVersion,
    channel: row.channel,
    renderedText: row.renderedText,
    deliveredById: row.deliveredById,
    deliveredByName: row.deliveredByName,
    deliveredAt: row.deliveredAt,
    recipientMasked: row.recipientMasked,
    sentToResponsible: row.sentToResponsible,
    tokenHash: row.tokenHash,
    tokenExpiresAt: row.tokenExpiresAt,
    firstOpenedAt: row.firstOpenedAt,
    createdAt: row.createdAt,
  };
}

/**
 * DX-019-ter: la marca con la que se reimprime (o abre por el enlace) una
 * entrega: nombre y color de hoy, pero el logo congelado al entregarla, nunca
 * el de hoy; NULL = se entregó sin logo y se muestra sin él.
 */
async function frozenClinicOf(
  tx: Prisma.TransactionClient,
  tenantId: string,
  clinicLogoKey: string | null,
): Promise<{
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
}> {
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { name: true, primaryColor: true },
  });
  return { ...tenant, logoUrl: clinicLogoPublicUrl(clinicLogoKey) };
}

/**
 * Entregas de indicaciones postoperatorias (DX-222). Todo bajo RLS
 * (`runWithTenant`): una cita, un paciente o una entrega de otra clínica no
 * existen. Sin delete y sin más update que la primera apertura: la entrega es
 * inalterable (trigger `post_op_deliveries_immutable`).
 */
@Injectable()
export class PrismaPostOpDeliveryRepository implements PostOpDeliveryRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  loadAppointmentContext(
    appointmentId: string,
  ): Promise<PostOpAppointmentContext | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const appointment = await tx.appointment.findFirst({
        where: { id: appointmentId, tenantId, deletedAt: null },
        select: {
          id: true,
          patientId: true,
          locationId: true,
          appointmentTypeId: true,
          start: true,
          status: true,
          providerId: true,
          patient: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              birthDate: true,
              emergencyContactName: true,
              reminderOptOutAt: true,
              contactChannel: true,
              deletedAt: true,
            },
          },
          location: {
            select: {
              id: true,
              name: true,
              phone: true,
              defaultPhoneRegion: true,
              timeZone: true,
              locale: true,
              hourCycle: true,
            },
          },
        },
      });
      if (!appointment || appointment.patient.deletedAt) return null;
      const { patient, location } = appointment;

      const [provider, tenant, responsibles, majorityReview, majorityAge] =
        await Promise.all([
          tx.clinicMembership.findFirst({
            where: { userId: appointment.providerId },
            orderBy: { createdAt: 'desc' },
            select: { user: { select: { fullName: true } } },
          }),
          tx.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: { name: true },
          }),
          loadNoticeResponsibles(tx, appointment.patientId),
          loadMajorityReview(tx, appointment.patientId),
          loadTenantMajorityAge(tx, tenantId),
        ]);

      return {
        appointment: {
          id: appointment.id,
          patientId: appointment.patientId,
          locationId: appointment.locationId,
          appointmentTypeId: appointment.appointmentTypeId,
          start: appointment.start,
          status: appointment.status,
          providerName: provider?.user.fullName ?? '',
        },
        patient: {
          firstName: patient.firstName,
          lastName: patient.lastName,
          email: patient.email,
          phone: patient.phone,
          birthDate: patient.birthDate,
          emergencyContactName: patient.emergencyContactName,
          reminderOptOutAt: patient.reminderOptOutAt,
          contactChannel: patient.contactChannel,
        },
        responsibles,
        majorityReview,
        location: {
          id: location.id,
          name: location.name,
          phone: location.phone,
          defaultPhoneRegion: location.defaultPhoneRegion,
          timeZone: requireLocationTimeZone(location),
          locale: location.locale,
          hourCycle: location.hourCycle,
        },
        clinicName: tenant.name,
        majorityAge,
      };
    });
  }

  performedCatalogItemIds(input: {
    appointmentId: string;
    patientId: string;
    day: string;
    timeZone: string;
  }): Promise<string[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const entries = await tx.clinicalEntry.findMany({
        where: {
          patientId: input.patientId,
          appointmentId: input.appointmentId,
          deletedAt: null,
        },
        select: { id: true },
      });
      const items = await performedItemsOf(
        tx,
        input.patientId,
        entries.map((e) => e.id),
        input.day,
        input.timeZone,
      );
      return items.map((item) => item.catalogItemId);
    });
  }

  userName(userId: string): Promise<string | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const membership = await tx.clinicMembership.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { user: { select: { fullName: true } } },
      });
      return membership?.user.fullName ?? null;
    });
  }

  async create(input: CreatePostOpDeliveryRepoInput): Promise<PostOpDelivery> {
    const tenantId = this.requireTenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        // DX-019-ter: la entrega congela la clave del logo de este instante,
        // leída en la transacción que la registra (la protege el trigger).
        // NULL = se entregó sin logo.
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { logoKey: true },
        });
        return toEntity(
          await tx.postOpInstructionDelivery.create({
            data: {
              tenantId,
              ...input,
              clinicLogoKey: clinicLogoKeyToFreeze(tenant.logoKey),
            },
          }),
        );
      });
    } catch (err) {
      // DX-250: la misma `Idempotency-Key` deriva el mismo id (clave primaria).
      if (
        input.id &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new PostOpDeliveryAlreadyExistsError();
      }
      throw err;
    }
  }

  findById(id: string): Promise<PostOpDelivery | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.postOpInstructionDelivery.findFirst({
        where: { id },
      });
      return row ? toEntity(row) : null;
    });
  }

  emailStatuses(
    deliveryIds: string[],
  ): Promise<Map<string, PostOpEmailStatus>> {
    const statuses = new Map<string, PostOpEmailStatus>();
    if (deliveryIds.length === 0) return Promise.resolve(statuses);
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.emailOutbox.findMany({
        where: {
          template: EmailTemplate.POST_OP_INSTRUCTIONS,
          referenceId: { in: deliveryIds },
        },
        select: { referenceId: true, status: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const row of rows) {
        if (!row.referenceId) continue;
        statuses.set(
          row.referenceId,
          row.status === EmailOutboxStatus.SENT
            ? 'SENT'
            : row.status === EmailOutboxStatus.FAILED
              ? 'NOT_SENT'
              : 'QUEUED',
        );
      }
      return statuses;
    });
  }

  listByAppointment(appointmentId: string): Promise<PostOpDelivery[]> {
    return this.prisma.runWithTenant(async (tx) =>
      (
        await tx.postOpInstructionDelivery.findMany({
          where: { appointmentId },
          orderBy: NEWEST_FIRST,
        })
      ).map(toEntity),
    );
  }

  listByPatient(patientId: string): Promise<PostOpDelivery[]> {
    return this.prisma.runWithTenant(async (tx) =>
      (
        await tx.postOpInstructionDelivery.findMany({
          where: { patientId },
          orderBy: NEWEST_FIRST,
        })
      ).map(toEntity),
    );
  }

  findForPatient(
    patientId: string,
    id: string,
  ): Promise<PostOpDeliveryDocumentView | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.postOpInstructionDelivery.findFirst({
        where: { id, patientId },
        include: {
          location: {
            select: { name: true, phone: true, ...DOCUMENT_REGIONAL_SELECT },
          },
          patient: { select: { firstName: true, lastName: true } },
        },
      });
      if (!row) return null;
      const clinic = await frozenClinicOf(tx, tenantId, row.clinicLogoKey);
      const { location, patient, ...delivery } = row;
      return {
        ...toEntity(delivery),
        clinic,
        locationName: location.name,
        locationPhone: location.phone,
        regional: documentRegional(location),
        patientName: `${patient.firstName} ${patient.lastName}`,
      };
    });
  }

  findByTokenHash(tokenHash: string): Promise<PostOpPublicDeliveryView | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.postOpInstructionDelivery.findFirst({
        where: { tokenHash },
        include: { location: { select: { phone: true } } },
      });
      if (!row) return null;
      const clinic = await frozenClinicOf(tx, tenantId, row.clinicLogoKey);
      const { location, ...delivery } = row;
      return { ...toEntity(delivery), clinic, locationPhone: location.phone };
    });
  }

  markFirstOpened(id: string): Promise<boolean> {
    // `firstOpenedAt: null` en el where: dos aperturas a la vez solo marcan
    // una, y la segunda no llega al trigger (no actualiza ninguna fila).
    return this.prisma.runWithTenant(async (tx) => {
      const { count } = await tx.postOpInstructionDelivery.updateMany({
        where: { id, firstOpenedAt: null },
        data: { firstOpenedAt: new Date() },
      });
      return count > 0;
    });
  }
}
