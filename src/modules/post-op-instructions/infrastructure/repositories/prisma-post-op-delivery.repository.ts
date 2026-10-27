import { Injectable } from '@nestjs/common';
import type { PostOpInstructionDelivery, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { requireLocationTimeZone } from '../../../../shared/locations/location-time-zone';
import { loadNoticeResponsibles } from '../../../patients/infrastructure/notices/notice-context';
import { performedItemsOf } from '../../../clinical-entries/infrastructure/repositories/performed-items';
import type { PostOpDelivery } from '../../domain/entities/post-op-delivery.entity';
import type {
  CreatePostOpDeliveryRepoInput,
  PostOpAppointmentContext,
  PostOpDeliveryDocumentView,
  PostOpDeliveryRepository,
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
              country: true,
              timeZone: true,
              locale: true,
              hourCycle: true,
            },
          },
        },
      });
      if (!appointment || appointment.patient.deletedAt) return null;
      const { patient, location } = appointment;

      const [provider, tenant, responsibles] = await Promise.all([
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
      ]);

      return {
        appointment: {
          id: appointment.id,
          patientId: appointment.patientId,
          locationId: appointment.locationId,
          appointmentTypeId: appointment.appointmentTypeId,
          start: appointment.start,
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
        location: {
          id: location.id,
          name: location.name,
          phone: location.phone,
          country: location.country,
          timeZone: requireLocationTimeZone(location),
          locale: location.locale,
          hourCycle: location.hourCycle,
        },
        clinicName: tenant.name,
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

  create(input: CreatePostOpDeliveryRepoInput): Promise<PostOpDelivery> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) =>
      toEntity(
        await tx.postOpInstructionDelivery.create({
          data: { tenantId, ...input },
        }),
      ),
    );
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
          location: { select: { name: true, phone: true } },
          patient: { select: { firstName: true, lastName: true } },
        },
      });
      if (!row) return null;
      const clinic = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true, logoUrl: true, primaryColor: true },
      });
      const { location, patient, ...delivery } = row;
      return {
        ...toEntity(delivery),
        clinic,
        locationName: location.name,
        locationPhone: location.phone,
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
      const clinic = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true, logoUrl: true, primaryColor: true },
      });
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
