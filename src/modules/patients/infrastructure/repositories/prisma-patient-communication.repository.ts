import { effectiveCommunicationChanges } from '../../domain/communication/communication-changes';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ContactChannel, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  PATIENT_NOT_FOUND_MESSAGE,
  type PatientCommunicationUpdate,
  type PatientCommunicationUpdateResult,
  type PatientOptOutMatchWarningView,
  type PatientCommunicationRepository,
  type PatientCommunicationState,
} from '../../domain/ports/patient-communication-repository.port';
import {
  loadNoticeSettings,
  loadNoticeResponsibles,
} from '../notices/notice-context';

const SELECT = {
  id: true,
  firstName: true,
  birthDate: true,
  emergencyContactName: true,
  countryCode: true,
  phone: true,
  email: true,
  contactChannel: true,
  whatsappOptInAt: true,
  whatsappOptInSource: true,
  whatsappOptInById: true,
  reminderOptOutAt: true,
  reminderOptOutSource: true,
} as const satisfies Prisma.PatientSelect;

type Row = Prisma.PatientGetPayload<{ select: typeof SELECT }>;

@Injectable()
export class PrismaPatientCommunicationRepository implements PatientCommunicationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * El autor del opt-in es un usuario global; su nombre se lee por la
   * membresía (con RLS), así que solo aparece si es o fue de esta clínica.
   */
  private async toState(
    tx: Prisma.TransactionClient,
    row: Row,
  ): Promise<PatientCommunicationState> {
    const { whatsappOptInById, id, ...rest } = row;
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    const [membership, responsibles, noticeSettings] = await Promise.all([
      whatsappOptInById
        ? tx.clinicMembership.findFirst({
            where: { userId: whatsappOptInById },
            orderBy: { createdAt: 'desc' },
            select: { user: { select: { fullName: true } } },
          })
        : null,
      loadNoticeResponsibles(tx, id),
      loadNoticeSettings(
        tx,
        tenantId,
        this.tenantContext.getLocationId() ?? null,
      ),
    ]);
    return {
      patientId: id,
      ...rest,
      responsibles,
      noticeSettings,
      whatsappOptInBy: whatsappOptInById
        ? {
            id: whatsappOptInById,
            fullName: membership?.user.fullName ?? null,
          }
        : null,
    };
  }

  find(patientId: string): Promise<PatientCommunicationState | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: SELECT,
      });
      return row ? this.toState(tx, row) : null;
    });
  }

  optOutWarnings(
    patientId: string,
  ): Promise<PatientOptOutMatchWarningView[] | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: { id: true },
      });
      if (!patient) return null;
      return tx.reminderOptOutMatchWarning.findMany({
        where: { patientId },
        take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          createdAt: true,
          matchCount: true,
          maxMatches: true,
        },
      });
    });
  }

  async locationCountry(): Promise<string | null> {
    const active = this.tenantContext.getLocationId();
    const location = await this.prisma.runWithTenant((tx) =>
      tx.location.findFirst({
        where: { deletedAt: null, ...(active ? { id: active } : {}) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { country: true },
      }),
    );
    return location?.country ?? null;
  }

  async clinicDefaultChannel(): Promise<ContactChannel> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    // `tenants` no tiene RLS: se lee por el id del contexto.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { defaultContactChannel: true },
    });
    return tenant?.defaultContactChannel ?? ContactChannel.EMAIL;
  }

  update(
    patientId: string,
    update: PatientCommunicationUpdate,
    invalidateOptOutLinksAt?: Date,
  ): Promise<PatientCommunicationUpdateResult> {
    return this.prisma.runWithTenant(async (tx) => {
      // El mismo orden que emisión/consumo: paciente, después enlaces.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "patients" WHERE "id" = ${patientId}::uuid
          AND "deletedAt" IS NULL FOR UPDATE`;
      if (!locked.length)
        throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
      const row = await tx.patient.findFirstOrThrow({
        where: { id: patientId },
        select: SELECT,
      });
      const current = await this.toState(tx, row);
      const patch = typeof update === 'function' ? update(current) : update;
      const changedFields = effectiveCommunicationChanges(current, patch);
      let state = current;
      if (changedFields.length) {
        const saved = await tx.patient.update({
          where: { id: patientId },
          data: patch,
          select: SELECT,
        });
        state = await this.toState(tx, saved);
      }
      // Se invalida incluso con preferencias iguales; no crea una falsa escritura de paciente.
      if (invalidateOptOutLinksAt) {
        await tx.reminderOptOutLink.updateMany({
          where: { patientId, usedAt: null },
          data: { usedAt: invalidateOptOutLinksAt },
        });
      }
      return { state, changedFields };
    });
  }
}
