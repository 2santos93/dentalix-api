import { Injectable, NotFoundException } from '@nestjs/common';
import { ContactChannel, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  PATIENT_NOT_FOUND_MESSAGE,
  type PatientCommunicationPatch,
  type PatientCommunicationRepository,
  type PatientCommunicationState,
} from '../../domain/ports/patient-communication-repository.port';

const SELECT = {
  id: true,
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
    const membership = whatsappOptInById
      ? await tx.clinicMembership.findFirst({
          where: { userId: whatsappOptInById },
          orderBy: { createdAt: 'desc' },
          select: { user: { select: { fullName: true } } },
        })
      : null;
    return {
      patientId: id,
      ...rest,
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
    patch: PatientCommunicationPatch,
  ): Promise<PatientCommunicationState> {
    return this.prisma.runWithTenant(async (tx) => {
      const { count } = await tx.patient.updateMany({
        where: { id: patientId, deletedAt: null },
        data: patch,
      });
      if (count === 0) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
      const row = await tx.patient.findFirstOrThrow({
        where: { id: patientId },
        select: SELECT,
      });
      return this.toState(tx, row);
    });
  }
}
