import {
  claimPlanItemInTx,
  findPlanItemsReservedElsewhere,
  isPlanItemConflict,
  lockAppointmentForPlanItems,
  planItemConflictMessage,
  recoverReservationsInTx,
  replaceAppointmentPlanItems,
} from '../appointment-plan-items';
import {
  planItemsClosedMessage,
  planItemsEditable,
} from '../../domain/plan-item-reservation';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import {
  nextVisitMinimums,
  type VisitMinimumSnapshot,
} from '../../../treatment-plans/infrastructure/visit-minimums';
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
  computeCancellationNotice,
  type CurrentPolicyRef,
} from '../../../cancellation-policies/domain/cancellation-policy';
import { findCurrentPolicyInTx } from '../../../cancellation-policies/infrastructure/current-policy';
import { cancellationAuditMetadata } from '../../domain/cancellation-audit';
import {
  AppointmentRepository,
  AppointmentUpdate,
  CancellationWrite,
  CreateAppointmentRepoInput,
  InClinicAppointment,
  ListAppointmentsByRangeParams,
  ListInClinicParams,
  ListUpcomingAppointmentsParams,
  PlanItemClaim,
  UpdateAppointmentRepoInput,
} from '../../domain/ports/appointment-repository.port';
import {
  Appointment,
  CompletedExit,
  PlanItemReservedElsewhere,
  VisitMinimumChange,
} from '../../domain/entities/appointment.entity';

type PrismaAppointment = Prisma.AppointmentGetPayload<Record<string, never>>;

/** DX-279: la cita deja de estar cancelada: sin datos de una cancelación. */
const CLEARED_CANCELLATION = {
  cancelledAt: null,
  cancelledByKind: null,
  cancelReasonCode: null,
  cancelReasonText: null,
  noticeMinutes: null,
  lateCancellation: null,
} as const satisfies Prisma.AppointmentUpdateManyMutationInput;

/**
 * Joins just the patient's name onto an appointment — enough for a client to
 * label it without fetching the patient list (see `Appointment.patientFirstName`).
 */
export const INCLUDE_PATIENT_NAME = {
  planItems: { where: { deletedAt: null }, select: { planItemId: true } },
  patient: { select: { firstName: true, lastName: true } },
  // DX-121: el tipo embebido, aunque esté desactivado o retirado (la cita no
  // cambia por eso). La FK compuesta garantiza que es de la misma clínica.
  appointmentType: {
    select: { id: true, name: true, durationMinutes: true, color: true },
  },
  // DX-211: el sillón embebido, aunque esté desactivado (la cita lo conserva).
  // La FK compuesta garantiza que es de la misma clínica y sede.
  chair: { select: { id: true, name: true, active: true } },
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
  chair?: { id: string; name: string; active: boolean } | null;
};

export function mapToEntity(
  appointment: PrismaAppointmentWithPatient,
): Appointment {
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
    cancelledAt: appointment.cancelledAt,
    cancelledByKind: appointment.cancelledByKind,
    cancelReasonCode: appointment.cancelReasonCode,
    cancelReasonText: appointment.cancelReasonText,
    noticeMinutes: appointment.noticeMinutes,
    lateCancellation: appointment.lateCancellation,
    noShowMarkedAt: appointment.noShowMarkedAt,
    policyVersionId: appointment.policyVersionId,
    triageFlags: appointment.triageFlags,
    triageNote: appointment.triageNote,
    walkIn: appointment.walkIn,
    overbooked: appointment.overbooked,
    chairId: appointment.chairId,
    chair: appointment.chair ?? null,
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
            chairId: input.chairId,
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
      .catch((error: unknown) =>
        this.rethrowPlanItemConflict(error, input.planItemIds ?? []),
      );
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
      // DX-211: columnas por sillón (appointments_tenant_location_chair_start_idx).
      ...(params.chairIds ? { chairId: { in: params.chairIds } } : {}),
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
      // DX-470: un sobrecupo no ocupa el hueco del profesional (tampoco en la
      // EXCLUDE appointments_no_overlap_per_provider).
      overbooked: false,
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

  async findOverlappingForChair(
    chairId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<Appointment[]> {
    // Mismo solape medio-abierto que `findOverlapping`, espejo de la EXCLUDE
    // appointments_no_overlap_per_chair: un sobrecupo SÍ ocupa el sillón.
    const where: Prisma.AppointmentWhereInput = {
      chairId,
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
        const existing = await lockAppointmentForPlanItems(
          tx,
          this.requireTenantId(),
          id,
        );
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
          completedExit,
          audit,
          cancel,
          clearCancellation,
          ...rest
        } = patch;
        // DX-279: los datos de la cancelación van en la MISMA sentencia que el
        // estado (la CHECK appointments_cancellation_check se mira por fila).
        const data: Prisma.AppointmentUncheckedUpdateManyInput = {
          ...rest,
          ...(cancel ? await this.cancellationData(tx, id, cancel) : {}),
          ...(clearCancellation ? CLEARED_CANCELLATION : {}),
        };
        // DX-273 (revisión I1): lo que esta cita reserva ANTES del cambio; si
        // deja de reservarlo, una cita en la clínica puede recuperarlo.
        const reservedBefore = (
          await tx.appointmentPlanItem.findMany({
            where: { appointmentId: id, active: true, deletedAt: null },
            select: { planItemId: true },
          })
        ).map((l) => l.planItemId);
        // DX-273: el mínimo de la visita siguiente ANTES de sacar la cita de
        // COMPLETED (con la fila bloqueada), para dejar claro qué cambia.
        const minimumsBefore =
          completedExit && existing.status === AppointmentStatus.COMPLETED
            ? await this.visitMinimums(tx, id)
            : null;
        // DX-271 (BE-039): con la fila bloqueada, los ítems de una cita que
        // sigue cerrada (antes y después de este PATCH) no se tocan; nada de
        // la petición se escribe.
        if (
          planItemIds !== undefined &&
          !planItemsEditable(
            existing,
            {
              status: rest.status ?? existing.status,
              start: rest.start ?? existing.start,
            },
            new Date(),
          )
        ) {
          throw new ConflictException(
            planItemsClosedMessage(existing, new Date()),
          );
        }
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
            existing,
          );
        }
        const exit =
          completedExit && minimumsBefore
            ? await this.recordCompletedExit(
                tx,
                appointment,
                completedExit,
                minimumsBefore,
              )
            : undefined;
        // Completada: el tratamiento se hizo aquí; no vuelve a otra cita.
        if (
          reservedBefore.length > 0 &&
          appointment.status !== AppointmentStatus.COMPLETED
        ) {
          const still = new Set(
            (
              await tx.appointmentPlanItem.findMany({
                where: { appointmentId: id, active: true, deletedAt: null },
                select: { planItemId: true },
              })
            ).map((l) => l.planItemId),
          );
          await recoverReservationsInTx(
            tx,
            this.requireTenantId(),
            id,
            reservedBefore.filter((p) => !still.has(p)),
            audit,
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
          ...(exit ? { completedExit: exit } : {}),
        };
      })
      .catch((error: unknown) =>
        // DX-271: un cambio de estado del día ya no choca (el trigger deja la
        // reserva en la otra cita); esto es el alta o edición explícita de
        // `planItemIds`, reagendar o reactivar.
        this.rethrowPlanItemConflict(error, patch.planItemIds, id),
      );
  }

  /**
   * DX-279: columnas de una cancelación. El aviso se cuenta desde la hora del
   * servidor hasta el inicio de la cita (cancelar y mover a la vez da 400 en
   * el caso de uso) y se compara con la política vigente de SU sede, leída en
   * esta transacción.
   */
  private async cancellationData(
    tx: Prisma.TransactionClient,
    id: string,
    cancel: CancellationWrite,
  ): Promise<Prisma.AppointmentUpdateManyMutationInput> {
    const row = await tx.appointment.findFirstOrThrow({
      where: { id },
      select: { locationId: true, start: true },
    });
    const policy = await findCurrentPolicyInTx(tx, row.locationId);
    const notice = computeCancellationNotice({
      start: row.start,
      cancelledAt: cancel.at,
      byKind: cancel.byKind,
      noticeHours: policy?.noticeHours ?? null,
      attended: cancel.attended,
    });
    return {
      cancelledAt: cancel.at,
      cancelledByKind: cancel.byKind,
      cancelReasonCode: cancel.reasonCode,
      cancelReasonText: cancel.reasonText,
      noticeMinutes: notice.noticeMinutes,
      lateCancellation: notice.lateCancellation,
    };
  }

  currentCancellationPolicy(
    locationId: string,
  ): Promise<CurrentPolicyRef | null> {
    return this.prisma.runWithTenant((tx) =>
      findCurrentPolicyInTx(tx, locationId),
    );
  }

  /**
   * El ítem ya está reservado en otra cita viva: 409 que dice en cuál (fecha
   * en la zona de su sede). Cualquier otro error sigue su camino. Sin
   * `planItemIds` explícitos, los ítems vivos de la cita.
   */
  private async rethrowPlanItemConflict(
    error: unknown,
    planItemIds: string[] | undefined,
    appointmentId?: string,
  ): Promise<never> {
    if (!isPlanItemConflict(error)) throw error;
    const tenantId = this.requireTenantId();
    const message = await this.prisma.runWithTenant(async (tx) => {
      const ids =
        planItemIds ??
        (
          await tx.appointmentPlanItem.findMany({
            where: { appointmentId, deletedAt: null },
            select: { planItemId: true },
          })
        ).map((l) => l.planItemId);
      return planItemConflictMessage(
        tx,
        tenantId,
        ids,
        appointmentId,
        this.tenantContext.getAllowedLocationIds(),
      );
    });
    throw new ConflictException(message);
  }

  /** Mínimos de las visitas siguientes a las de la cita (DX-273). */
  private async visitMinimums(
    tx: Prisma.TransactionClient,
    appointmentId: string,
  ): Promise<VisitMinimumSnapshot[]> {
    const { locationId } = await tx.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      select: { locationId: true },
    });
    return nextVisitMinimums(
      tx,
      this.requireTenantId(),
      appointmentId,
      locationId,
      new Date(),
    );
  }

  /**
   * DX-273: la cita salió de COMPLETED. En la misma transacción: el motivo
   * (`appointment_status_reversals`), el mínimo de la visita siguiente antes
   * y después, y su `audit_event` (sin el texto del motivo, que no es un
   * código: la auditoría lo enlaza por `params.reversalId`).
   */
  private async recordCompletedExit(
    tx: Prisma.TransactionClient,
    appointment: Parameters<typeof cancellationAuditMetadata>[0] & {
      id: string;
      patientId: string;
      status: AppointmentStatus;
    },
    exit: { reason: string; audit: AuditRequestContext },
    before: VisitMinimumSnapshot[],
  ): Promise<CompletedExit> {
    const tenantId = this.requireTenantId();
    const after = await this.visitMinimums(tx, appointment.id);
    const visitMinimums: VisitMinimumChange[] = before.map((b) => {
      const a = after.find((x) => x.planId === b.planId && x.visit === b.visit);
      return {
        planId: b.planId,
        visit: b.visit,
        minimumDayBefore: b.minimumDay,
        minimumDayAfter: a?.minimumDay ?? null,
        anchorAppointmentIdAfter: a?.anchorAppointmentId ?? null,
      };
    });
    const reversal = await tx.appointmentStatusReversal.create({
      data: {
        tenantId,
        patientId: appointment.patientId,
        appointmentId: appointment.id,
        fromStatus: AppointmentStatus.COMPLETED,
        toStatus: appointment.status,
        reason: exit.reason,
        actorUserId: exit.audit.actor.userId,
      },
      select: { id: true },
    });
    await writeAuditEvent(tx, {
      tenantId,
      locationId: exit.audit.locationId,
      actor: {
        kind: 'user',
        userId: exit.audit.actor.userId,
        role: exit.audit.actor.role,
      },
      action: 'UPDATE',
      resourceType: 'APPOINTMENT',
      resourceId: appointment.id,
      patient: { kind: 'patient', id: appointment.patientId },
      requestId: exit.audit.requestId,
      ip: exit.audit.ip,
      userAgent: exit.audit.userAgent,
      metadata: {
        reason: 'COMPLETED_EXIT',
        status: { from: AppointmentStatus.COMPLETED, to: appointment.status },
        params: { reversalId: reversal.id },
        // B2 (DX-279): sacar de «Completada» a «Cancelada» lleva aquí su
        // cancelación, sin un segundo evento.
        ...cancellationAuditMetadata(appointment),
        visitMinimums: visitMinimums.map((v) => ({
          planId: v.planId,
          visit: v.visit,
          before: v.minimumDayBefore,
          after: v.minimumDayAfter,
        })),
      },
    });
    return { reversalId: reversal.id, reason: exit.reason, visitMinimums };
  }

  findPlanItemsReservedElsewhere(
    appointmentIds: readonly string[],
  ): Promise<Map<string, PlanItemReservedElsewhere[]>> {
    if (appointmentIds.length === 0)
      return Promise.resolve(new Map<string, PlanItemReservedElsewhere[]>());
    return this.prisma.runWithTenant((tx) =>
      findPlanItemsReservedElsewhere(
        tx,
        this.requireTenantId(),
        appointmentIds,
        this.tenantContext.getAllowedLocationIds(),
      ),
    );
  }

  async claimPlanItem(
    appointmentId: string,
    planItemId: string,
    audit: AuditRequestContext,
  ): Promise<PlanItemClaim> {
    return this.prisma
      .runWithTenant(async (tx) => {
        const { fromAppointmentId } = await claimPlanItemInTx(tx, {
          tenantId: this.requireTenantId(),
          appointmentId,
          planItemId,
          allowedLocations: this.tenantContext.getAllowedLocationIds(),
          audit,
        });
        return {
          appointment: mapToEntity(
            await tx.appointment.findUniqueOrThrow({
              where: { id: appointmentId },
              include: INCLUDE_PATIENT_NAME,
            }),
          ),
          fromAppointmentId,
        };
      })
      .catch((error: unknown) =>
        // Otra cita lo tomó a la vez: 409 que dice cuál.
        this.rethrowPlanItemConflict(error, [planItemId], appointmentId),
      );
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
        include: {
          ...INCLUDE_PATIENT_NAME,
          appointmentType: {
            select: {
              ...INCLUDE_PATIENT_NAME.appointmentType.select,
              isUrgent: true,
            },
          },
        },
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
      return appointments.map(({ appointmentType, ...a }) => ({
        ...mapToEntity({
          ...a,
          appointmentType: appointmentType && {
            id: appointmentType.id,
            name: appointmentType.name,
            durationMinutes: appointmentType.durationMinutes,
            color: appointmentType.color,
          },
        }),
        providerName: names.get(a.providerId) ?? null,
        urgent: appointmentType?.isUrgent ?? false,
      }));
    });
  }
}
