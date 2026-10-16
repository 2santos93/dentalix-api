import { Injectable } from '@nestjs/common';
import { Prisma, WaitlistStatus } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveDefaultLocationId } from '../../../../shared/locations/default-location';
import type {
  WaitlistEntry,
  WaitlistPage,
} from '../../domain/entities/waitlist-entry.entity';
import type {
  CreateWaitlistEntryRepoInput,
  ListWaitlistParams,
  WaitlistRepository,
} from '../../domain/ports/waitlist-repository.port';

/** Lo que el panel enseña sin otra petición: paciente, cita de origen y tipo. */
const INCLUDE_VIEW = {
  patient: { select: { firstName: true, lastName: true, phone: true } },
  sourceAppointment: { select: { start: true, end: true, status: true } },
  appointmentType: {
    select: { id: true, name: true, durationMinutes: true, color: true },
  },
} as const satisfies Prisma.AppointmentWaitlistEntryInclude;

type Row = Prisma.AppointmentWaitlistEntryGetPayload<{
  include: typeof INCLUDE_VIEW;
}>;

function mapToEntity(row: Row): WaitlistEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    locationId: row.locationId,
    patientId: row.patientId,
    patientFirstName: row.patient.firstName,
    patientLastName: row.patient.lastName,
    patientPhone: row.patient.phone,
    sourceAppointmentId: row.sourceAppointmentId,
    sourceAppointment: row.sourceAppointment,
    providerId: row.providerId,
    appointmentTypeId: row.appointmentTypeId,
    appointmentType: row.appointmentType,
    durationMinutes: row.durationMinutes,
    priority: row.priority,
    preferredWindow: row.preferredWindow,
    note: row.note,
    status: row.status,
    resolvedAppointmentId: row.resolvedAppointmentId,
    dismissReason: row.dismissReason,
    createdById: row.createdById,
    resolvedById: row.resolvedById,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class PrismaWaitlistRepository implements WaitlistRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  list(params: ListWaitlistParams): Promise<WaitlistPage> {
    // Como la agenda: sede explícita > sede del request > vista consolidada.
    const locationId = params.locationId ?? this.tenantContext.getLocationId();
    const where: Prisma.AppointmentWaitlistEntryWhereInput = {
      status: params.status,
      // Un paciente archivado no se llama: sale de la lista (su entrada queda).
      patient: { deletedAt: null },
      ...(locationId ? { locationId } : {}),
    };
    // Página y total en la MISMA foto (como la caja): una entrada que se
    // agenda entre las dos consultas no descuadra el contador.
    return this.prisma.runWithTenant(
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.appointmentWaitlistEntry.findMany({
            where,
            include: INCLUDE_VIEW,
            // URGENT va después de NORMAL en el enum: DESC la pone primero.
            orderBy: [
              { priority: 'desc' },
              { createdAt: 'asc' },
              { id: 'asc' },
            ],
            skip: (params.page - 1) * params.pageSize,
            take: params.pageSize,
          }),
          tx.appointmentWaitlistEntry.count({ where }),
        ]);
        return {
          items: rows.map(mapToEntity),
          total,
          page: params.page,
          pageSize: params.pageSize,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  findById(id: string): Promise<WaitlistEntry | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.appointmentWaitlistEntry.findFirst({
        where: { id },
        include: INCLUDE_VIEW,
      });
      return row ? mapToEntity(row) : null;
    });
  }

  hasOpenForPatient(patientId: string): Promise<boolean> {
    return this.prisma.runWithTenant(async (tx) => {
      const found = await tx.appointmentWaitlistEntry.findFirst({
        where: { patientId, status: WaitlistStatus.OPEN },
        select: { id: true },
      });
      return found !== null;
    });
  }

  async create(input: CreateWaitlistEntryRepoInput): Promise<WaitlistEntry> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma.runWithTenant(async (tx) =>
      tx.appointmentWaitlistEntry.create({
        data: {
          tenantId,
          locationId:
            input.locationId ??
            this.tenantContext.getLocationId() ??
            (await resolveDefaultLocationId(tx)),
          patientId: input.patientId,
          providerId: input.providerId,
          appointmentTypeId: input.appointmentTypeId,
          durationMinutes: input.durationMinutes,
          priority: input.priority,
          preferredWindow: input.preferredWindow,
          note: input.note,
          createdById: input.createdById,
        },
        include: INCLUDE_VIEW,
      }),
    );
    return mapToEntity(row);
  }

  dismiss(
    id: string,
    reason: string,
    dismissedById: string,
  ): Promise<WaitlistEntry | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // Condicional: solo una entrada que sigue OPEN (a prueba de carreras).
      const { count } = await tx.appointmentWaitlistEntry.updateMany({
        where: { id, status: WaitlistStatus.OPEN },
        data: {
          status: WaitlistStatus.DISMISSED,
          dismissReason: reason,
          resolvedById: dismissedById,
          resolvedAt: new Date(),
        },
      });
      if (count === 0) return null;
      const row = await tx.appointmentWaitlistEntry.findFirstOrThrow({
        where: { id },
        include: INCLUDE_VIEW,
      });
      return mapToEntity(row);
    });
  }
}
