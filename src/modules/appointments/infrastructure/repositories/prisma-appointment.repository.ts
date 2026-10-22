import {
  replaceAppointmentPlanItems,
  translatePlanItemConflict,
} from '../appointment-plan-items';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  enqueueWaitlistFromAppointment,
  markWaitlistEntryScheduled,
  resolveWaitlistForReactivated,
} from '../../../waitlist/infrastructure/waitlist-transitions';
import { WAITLIST_NOT_OPEN_MESSAGE } from '../../../waitlist/domain/waitlist-rules';
import { MOVABLE_STATUSES } from '../../../waitlist/domain/opening-candidates';
import { WANTS_EARLIER_GONE_MESSAGE } from '../../domain/wants-earlier';
import {
  IN_CLINIC_STATUSES,
  PATIENT_FLOW_MESSAGES,
} from '../../domain/patient-flow';
import {
  AppointmentRepository,
  AppointmentUpdate,
  CreateAppointmentRepoInput,
  InClinicAppointment,
  ListAppointmentsByRangeParams,
  ListInClinicParams,
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
  planItems: { where: { deletedAt: null }, select: { planItemId: true } },
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
  planItems?: { planItemId: string }[];
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
    planItemIds: appointment.planItems?.map((i) => i.planItemId) ?? [],
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
    wantsEarlier: appointment.wantsEarlier,
    arrivedAt: appointment.arrivedAt,
    seatedAt: appointment.seatedAt,
    readyForCheckoutAt: appointment.readyForCheckoutAt,
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

  resolveWriteLocationId(): Promise<string> {
    return this.prisma.runWithTenant((tx) =>
      this.tenantContext.writeLocationId(tx),
    );
  }

  async create(input: CreateAppointmentRepoInput): Promise<Appointment> {
    const tenantId = this.requireTenantId();
    const appointment = await this.prisma
      .runWithTenant(async (tx) => {
        if (input.waitlistEntryId !== undefined) {
          // Dos INSERT simultáneos pueden esperarse mutuamente dentro de EXCLUDE
          // (40P01), antes de producir el solape 23P01. Ordenar las asignaciones
          // del mismo profesional evita ese ciclo; la constraint sigue arbitrando
          // el horario y el caso de uso conserva su 409 específico.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(
          hashtext('dx_waitlist_assignment:' || ${tenantId}),
          hashtext(${input.providerId})
        )`;
        }
        const created = await tx.appointment.create({
          data: {
            // Sede explícita del caso de uso (DX-122: la de la entrada de
            // pendientes, ya permitida); si no, la del request o, sin cabecera,
            // la de escritura de la sesión (DX-089: la primera permitida del
            // restringido, la principal para los demás).
            locationId:
              input.locationId ??
              (await this.tenantContext.writeLocationId(tx)),
            tenantId,
            patientId: input.patientId,
            providerId: input.providerId,
            start: input.start,
            end: input.end,
            reason: input.reason,
            notes: input.notes,
            createdById: input.createdById,
            appointmentTypeId: input.appointmentTypeId,
            wantsEarlier: input.wantsEarlier,
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
        if (input.planItemIds !== undefined)
          await replaceAppointmentPlanItems(
            tx,
            tenantId,
            input.patientId,
            created.id,
            input.planItemIds,
          );
        return tx.appointment.findUniqueOrThrow({
          where: { id: created.id },
          include: INCLUDE_PATIENT_NAME,
        });
      })
      .catch(translatePlanItemConflict);
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
      // explícita (DX-121, ya permitida por el caso de uso) manda sobre la del
      // request; una de otra clínica no devuelve nada (RLS). Sin ninguna, las
      // sedes permitidas (DX-089) o la vista consolidada.
      ...(params.locationId
        ? { locationId: params.locationId }
        : this.tenantContext.locationScope()),
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
          ...this.tenantContext.locationScope(),
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
    return this.prisma
      .runWithTenant(async (tx) => {
        // Incluso PATCH solo planItemIds debe bloquear: Prisma puede omitir un UPDATE vacío.
        await tx.$queryRaw`SELECT id FROM appointments WHERE id=${id}::uuid AND "deletedAt" IS NULL FOR UPDATE`;

        const existing = await tx.appointment.findFirst({
          where: { id, deletedAt: null },
          select: { id: true },
        });
        if (!existing) {
          throw new NotFoundException('Appointment not found');
        }

        const {
          planItemIds,
          revokeConfirmations,
          enqueueWaitlist,
          resolveWaitlist,
          requireWantsEarlier,
          expectStatus,
          ...data
        } = patch;
        // Retirar excluidos ANTES de reactivar/reagendar: el trigger no debe
        // intentar reservar los vínculos antiguos que esta misma petición quita.
        if (planItemIds !== undefined) {
          await tx.appointmentPlanItem.updateMany({
            where: {
              appointmentId: id,
              deletedAt: null,
              planItemId: { notIn: planItemIds },
            },
            data: { deletedAt: new Date() },
          });
        }
        // DX-200: paso del flujo en la clínica. Condición (el estado leído) y
        // cambio en la MISMA sentencia: el UPDATE bloquea la fila, así que si dos
        // personas cambian el estado a la vez la segunda no cumple la condición.
        // Todo el cambio va junto: la CHECK de horas se mira por sentencia.
        if (expectStatus !== undefined) {
          const { count } = await tx.appointment.updateMany({
            where: { id, deletedAt: null, status: expectStatus },
            data,
          });
          if (count === 0) {
            throw new ConflictException(PATIENT_FLOW_MESSAGES.stale);
          }
        }
        // DX-210: «Asignar» un hueco a una cita marcada. El UPDATE condicional
        // bloquea la fila: si dos personas la mueven a la vez, la segunda
        // re-evalúa la condición tras el COMMIT de la primera y no la cumple.
        if (requireWantsEarlier) {
          const { count } = await tx.appointment.updateMany({
            where: {
              id,
              deletedAt: null,
              wantsEarlier: true,
              status: { in: [...MOVABLE_STATUSES] },
            },
            data: { wantsEarlier: false },
          });
          if (count === 0) {
            throw new ConflictException(WANTS_EARLIER_GONE_MESSAGE);
          }
        }
        const appointment =
          expectStatus !== undefined
            ? await tx.appointment.findFirstOrThrow({
                where: { id },
                include: INCLUDE_PATIENT_NAME,
              })
            : await tx.appointment.update({
                where: { id },
                data,
                include: INCLUDE_PATIENT_NAME,
              });
        if (planItemIds !== undefined) {
          await replaceAppointmentPlanItems(
            tx,
            this.requireTenantId(),
            appointment.patientId,
            id,
            planItemIds,
          );
        }
        if (revokeConfirmations) {
          await tx.appointmentConfirmation.updateMany({
            where: { appointmentId: id, revokedAt: null, respondedAt: null },
            data: { revokedAt: new Date() },
          });
        }
        // DX-122: cancelada o no-show → «Pendientes por agendar», en esta misma
        // transacción (si algo falla, ni la cita cambia ni aparece la entrada).
        const enqueued = enqueueWaitlist
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
          appointment: mapToEntity(
            await tx.appointment.findUniqueOrThrow({
              where: { id },
              include: INCLUDE_PATIENT_NAME,
            }),
          ),
          waitlistEntryId: enqueued && !enqueued.reopened ? enqueued.id : null,
          reopenedWaitlistEntryId:
            enqueued && enqueued.reopened ? enqueued.id : null,
          resolvedWaitlistEntryId,
        };
      })
      .catch(translatePlanItemConflict);
  }

  async undoArrival(id: string): Promise<Appointment | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // Una sola sentencia condicional: vuelve al estado previo SOLO si sigue
      // en ARRIVED (la CHECK de la tabla garantiza que entonces lo tiene).
      const reverted = await tx.$executeRaw`
        UPDATE "appointments"
           SET "status" = "preArrivalStatus",
               "preArrivalStatus" = NULL,
               "arrivedAt" = NULL,
               "updatedAt" = timezone('UTC', now())
         WHERE "id" = ${id}::uuid
           AND "deletedAt" IS NULL
           AND "status" = 'ARRIVED'`;
      if (reverted === 0) return null;
      const appointment = await tx.appointment.findFirstOrThrow({
        where: { id },
        include: INCLUDE_PATIENT_NAME,
      });
      return mapToEntity(appointment);
    });
  }

  async listInClinic(
    params: ListInClinicParams,
  ): Promise<InClinicAppointment[]> {
    return this.prisma.runWithTenant(async (tx) => {
      // `appointments_tenant_location_in_clinic_idx` (parcial). RLS acota a
      // la clínica; la sede y el día los pone el caso de uso.
      const appointments = await tx.appointment.findMany({
        where: {
          locationId: params.locationId,
          deletedAt: null,
          status: { in: [...IN_CLINIC_STATUSES] },
          start: { gte: params.from, lt: params.to },
          ...(params.providerId ? { providerId: params.providerId } : {}),
        },
        orderBy: [{ start: 'asc' }, { id: 'asc' }],
        include: INCLUDE_PATIENT_NAME,
      });
      const providerIds = [...new Set(appointments.map((a) => a.providerId))];
      // El nombre del profesional, a través de la membresía (con RLS): solo
      // aparece si es de esta clínica. Sin filtrar `deletedAt`: si dejó la
      // clínica, la cita sigue siendo suya.
      const memberships =
        providerIds.length === 0
          ? []
          : await tx.clinicMembership.findMany({
              where: { userId: { in: providerIds } },
              orderBy: { createdAt: 'desc' },
              select: { userId: true, user: { select: { fullName: true } } },
            });
      const names = new Map<string, string>();
      for (const m of memberships) {
        if (!names.has(m.userId)) names.set(m.userId, m.user.fullName);
      }
      return appointments.map((a) => ({
        ...mapToEntity(a),
        providerName: names.get(a.providerId) ?? null,
      }));
    });
  }
}
