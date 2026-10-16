import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { resolveDefaultLocationId } from '../../../../shared/locations/default-location';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  enqueueWaitlistFromAppointment,
  markWaitlistEntryScheduled,
  resolveWaitlistForReactivated,
} from '../../../waitlist/infrastructure/waitlist-transitions';
import { WAITLIST_NOT_OPEN_MESSAGE } from '../../../waitlist/domain/waitlist-rules';
import {
  AppointmentRepository,
  AppointmentUpdate,
  CreateAppointmentRepoInput,
  ListAppointmentsByRangeParams,
  ListUpcomingAppointmentsParams,
  UpdateAppointmentRepoInput,
} from '../../domain/ports/appointment-repository.port';
import { Appointment } from '../../domain/entities/appointment.entity';

type PrismaAppointment = Prisma.AppointmentGetPayload<Record<string, never>>;

/**
 * Joins just the patient's name onto an appointment — enough for a client to
 * label it without fetching the patient list (see `Appointment.patientFirstName`).
 */
const INCLUDE_PATIENT_NAME = {
  patient: { select: { firstName: true, lastName: true } },
  // DX-121: el tipo embebido, aunque esté desactivado o retirado (la cita no
  // cambia por eso). La FK compuesta garantiza que es de la misma clínica.
  appointmentType: {
    select: { id: true, name: true, durationMinutes: true, color: true },
  },
} as const;

/**
 * `patient` is optional on purpose: `findOverlapping` only needs the slots for
 * conflict detection, so it skips the join rather than paying for it, and the
 * entity's name fields come back null there.
 */
type PrismaAppointmentWithPatient = PrismaAppointment & {
  patient?: { firstName: string; lastName: string };
  appointmentType?: {
    id: string;
    name: string;
    durationMinutes: number;
    color: string;
  } | null;
};

function mapToEntity(appointment: PrismaAppointmentWithPatient): Appointment {
  return {
    id: appointment.id,
    tenantId: appointment.tenantId,
    locationId: appointment.locationId,
    patientId: appointment.patientId,
    patientFirstName: appointment.patient?.firstName ?? null,
    patientLastName: appointment.patient?.lastName ?? null,
    providerId: appointment.providerId,
    start: appointment.start,
    end: appointment.end,
    status: appointment.status,
    reason: appointment.reason,
    notes: appointment.notes,
    createdById: appointment.createdById,
    appointmentTypeId: appointment.appointmentTypeId,
    appointmentType: appointment.appointmentType ?? null,
    confirmationSentAt: appointment.confirmationSentAt,
    callbackRequestedAt: appointment.callbackRequestedAt,
    createdAt: appointment.createdAt,
    updatedAt: appointment.updatedAt,
  };
}

@Injectable()
export class PrismaAppointmentRepository implements AppointmentRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `tenantId` is NOT NULL at the DB level with no column default that
   * autofills from the RLS GUC, so — unlike a plain SELECT/UPDATE/DELETE,
   * which RLS filters transparently — an INSERT still needs the app to
   * supply it explicitly. We never take it from the input (never from the
   * client); we read it from the same request-scoped context that
   * `runWithTenant(fn)` uses to set `app.current_tenant`, so the value
   * written always matches the GUC the WITH CHECK policy validates against.
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  /**
   * Filtro por sede activa, o `{}` si el request no fijó ninguna (vista
   * consolidada de la clínica). Se aplica SOLO donde la sede es semánticamente
   * correcta — ver los comentarios en cada consulta.
   */
  private locationFilter(): { locationId?: string } {
    const locationId = this.tenantContext.getLocationId();
    return locationId ? { locationId } : {};
  }

  async create(input: CreateAppointmentRepoInput): Promise<Appointment> {
    const tenantId = this.requireTenantId();
    const appointment = await this.prisma.runWithTenant(async (tx) => {
      const created = await tx.appointment.create({
        data: {
          // Sede explícita del caso de uso (DX-122: la de la entrada de
          // pendientes); si no, la del request (X-Location-Id, ya validada
          // contra esta clínica); si no, la sede por defecto.
          locationId:
            input.locationId ??
            this.tenantContext.getLocationId() ??
            (await resolveDefaultLocationId(tx)),
          tenantId,
          patientId: input.patientId,
          providerId: input.providerId,
          start: input.start,
          end: input.end,
          reason: input.reason,
          notes: input.notes,
          createdById: input.createdById,
          appointmentTypeId: input.appointmentTypeId,
        },
        include: INCLUDE_PATIENT_NAME,
      });
      // DX-122: «Agendar aquí» desde pendientes. Si otra persona ya la agendó o
      // la descartó, el 409 deshace también la cita (misma transacción).
      if (
        input.waitlistEntryId !== undefined &&
        !(await markWaitlistEntryScheduled(
          tx,
          input.waitlistEntryId,
          created.id,
          input.createdById ?? null,
        ))
      ) {
        throw new ConflictException(WAITLIST_NOT_OPEN_MESSAGE);
      }
      return created;
    });
    return mapToEntity(appointment);
  }

  async findById(id: string): Promise<Appointment | null> {
    const appointment = await this.prisma.runWithTenant(async (tx) => {
      return tx.appointment.findFirst({
        where: { id, deletedAt: null },
        include: INCLUDE_PATIENT_NAME,
      });
    });
    return appointment ? mapToEntity(appointment) : null;
  }

  async listByRange(
    params: ListAppointmentsByRangeParams,
  ): Promise<Appointment[]> {
    const where: Prisma.AppointmentWhereInput = {
      deletedAt: null,
      start: { gte: params.from, lt: params.to },
      ...(params.providerId ? { providerId: params.providerId } : {}),
      // DX-121: columnas de la vista Día. `providerId IN (...)` lo sirve
      // `appointments_tenantId_providerId_start_idx` (DX-043).
      ...(params.providerIds ? { providerId: { in: params.providerIds } } : {}),
      // La agenda SÍ es por sede: una cita ocurre en un sitio físico. Una sede
      // explícita (DX-121) manda sobre la del request; una de otra clínica no
      // devuelve nada (RLS).
      ...(params.locationId
        ? { locationId: params.locationId }
        : this.locationFilter()),
    };

    return this.prisma.runWithTenant(async (tx) => {
      const appointments = await tx.appointment.findMany({
        where,
        orderBy: { start: 'asc' },
        include: INCLUDE_PATIENT_NAME,
      });
      return appointments.map(mapToEntity);
    });
  }

  async listUpcoming(
    params: ListUpcomingAppointmentsParams,
  ): Promise<Appointment[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const appointments = await tx.appointment.findMany({
        where: {
          deletedAt: null,
          start: { gte: params.from, lt: params.to },
          // Mismo criterio de sede que la agenda (`listByRange`).
          ...this.locationFilter(),
        },
        // Desempate por id: dos citas a la misma hora (distinto profesional)
        // salen siempre en el mismo orden.
        orderBy: [{ start: 'asc' }, { id: 'asc' }],
        take: params.limit,
        include: INCLUDE_PATIENT_NAME,
      });
      return appointments.map(mapToEntity);
    });
  }

  async findOverlapping(
    providerId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<Appointment[]> {
    const where: Prisma.AppointmentWhereInput = {
      providerId,
      deletedAt: null,
      status: { not: 'CANCELLED' },
      // Half-open interval overlap: [start,end) overlaps [s2,e2) iff
      // start < e2 AND s2 < end — i.e. this appointment's start is before
      // the other's end, AND this appointment's end is after the other's
      // start. Back-to-back (adjacent) appointments where one's end equals
      // the other's start do NOT satisfy both conditions, so they don't
      // overlap.
      start: { lt: end },
      end: { gt: start },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    };

    return this.prisma.runWithTenant(async (tx) => {
      const appointments = await tx.appointment.findMany({
        where,
        orderBy: { start: 'asc' },
      });
      return appointments.map(mapToEntity);
    });
  }

  async findOverlappingForPatient(
    patientId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<Appointment[]> {
    // Mismo criterio de solape medio-abierto que `findOverlapping` (ver el
    // detalle allí): dos citas contiguas no se solapan. Solo cambia el eje:
    // paciente en vez de profesional.
    const where: Prisma.AppointmentWhereInput = {
      patientId,
      deletedAt: null,
      status: { not: 'CANCELLED' },
      start: { lt: end },
      end: { gt: start },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    };

    return this.prisma.runWithTenant(async (tx) => {
      const appointments = await tx.appointment.findMany({
        where,
        orderBy: { start: 'asc' },
      });
      return appointments.map(mapToEntity);
    });
  }

  async update(
    id: string,
    patch: UpdateAppointmentRepoInput,
  ): Promise<AppointmentUpdate> {
    return this.prisma.runWithTenant(async (tx) => {
      const existing = await tx.appointment.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException('Appointment not found');
      }

      const { revokeConfirmations, enqueueWaitlist, resolveWaitlist, ...data } =
        patch;
      const appointment = await tx.appointment.update({
        where: { id },
        data,
        include: INCLUDE_PATIENT_NAME,
      });
      if (revokeConfirmations) {
        await tx.appointmentConfirmation.updateMany({
          where: { appointmentId: id, revokedAt: null, respondedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      // DX-122: cancelada o no-show → «Pendientes por agendar», en esta misma
      // transacción (si algo falla, ni la cita cambia ni aparece la entrada).
      const waitlistEntryId = enqueueWaitlist
        ? await enqueueWaitlistFromAppointment(
            tx,
            id,
            enqueueWaitlist.createdById,
          )
        : null;
      // DX-122 (revisión H1): reactivada → su entrada sale de la lista.
      const resolvedWaitlistEntryId = resolveWaitlist
        ? await resolveWaitlistForReactivated(
            tx,
            id,
            resolveWaitlist.resolvedById,
          )
        : null;
      return {
        appointment: mapToEntity(appointment),
        waitlistEntryId,
        resolvedWaitlistEntryId,
      };
    });
  }
}
