import { Injectable } from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import { leadsOnAppointmentCreatedInTx } from '../../../leads/infrastructure/lead-from-appointment';
import {
  hardBlockOver,
  lockAgenda,
} from '../../../schedule-blocks/infrastructure/agenda-lock';
import { ScheduleBlockedRaceError } from '../../../schedule-blocks/domain/schedule-block-rules';
import {
  loadMajorityReview,
  loadNoticeResponsibles,
  loadTenantMajorityAge,
} from '../../../patients/infrastructure/notices/notice-context';
import { requireLocationTimeZone } from '../../../../shared/locations/location-time-zone';
import type { Appointment } from '../../domain/entities/appointment.entity';
import {
  SeriesSlotWriteError,
  type AppointmentSeriesRepository,
  type AppointmentSeriesSnapshot,
  type ApplySeriesChangesInput,
  type CreateSeriesRepoInput,
  type SeriesNoticeContext,
} from '../../domain/ports/appointment-series-repository.port';
import {
  INCLUDE_PATIENT_NAME,
  PrismaAppointmentRepository,
  mapToEntity,
} from './prisma-appointment.repository';

/** Una serie con ≤ 26 citas: la transacción tiene un tope algo mayor (DX-431). */
const SERIES_TX_TIMEOUT_MS = 20_000;

/** SQLSTATE 40P01: interbloqueo (Postgres eligió esta transacción). */
export function isDeadlock(error: unknown): boolean {
  const cause = error instanceof SeriesSlotWriteError ? error.cause : error;
  if (cause instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = cause.meta as { code?: string } | undefined;
    return meta?.code === '40P01' || cause.message.includes('40P01');
  }
  if (cause instanceof Prisma.PrismaClientUnknownRequestError) {
    return cause.message.includes('40P01') || /deadlock/i.test(cause.message);
  }
  return false;
}

/**
 * DX-562: series de citas. La serie y sus citas, la cancelación y el
 * movimiento de «esta y las siguientes», cada uno en UNA transacción.
 *
 * Candados (siempre en este orden, sin ciclos): primero el de las series de
 * la clínica (`dx_appointment_series:<tenant>`), que serializa dos series a
 * la vez de la misma clínica (sus filas cruzadas por sillón o paciente no
 * llegan a esperarse en las EXCLUDE); luego el de la agenda (profesionales en
 * orden y la sede, DX-149), el mismo que toma una cita suelta. Una cita suelta
 * no toma el de las series: solo escribe una fila y no puede cerrar un ciclo.
 */
@Injectable()
export class PrismaAppointmentSeriesRepository implements AppointmentSeriesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly appointments: PrismaAppointmentRepository,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async findById(id: string): Promise<AppointmentSeriesSnapshot | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const series = await tx.appointmentSeries.findFirst({
        where: { id },
        select: {
          id: true,
          intervalWeeks: true,
          occurrences: true,
          cancelledAt: true,
        },
      });
      if (!series) return null;
      const rows = await tx.appointment.findMany({
        where: { seriesId: id, deletedAt: null },
        orderBy: [{ seriesIndex: 'asc' }, { id: 'asc' }],
        include: INCLUDE_PATIENT_NAME,
      });
      return { ...series, appointments: rows.map(mapToEntity) };
    });
  }

  private async lockSeries(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(
      hashtext(${'dx_appointment_series:' + tenantId}),
      0
    )`;
  }

  /** Un intento, y otro si Postgres lo eligió para romper un interbloqueo. */
  private async retryOnDeadlock<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!isDeadlock(error)) throw error;
      return run();
    }
  }

  create(
    input: CreateSeriesRepoInput,
  ): Promise<{ seriesId: string; appointments: Appointment[] }> {
    const tenantId = this.requireTenantId();
    return this.retryOnDeadlock(() =>
      this.prisma.runWithTenant(
        async (tx) => {
          await this.lockSeries(tx, tenantId);
          await lockAgenda(tx, tenantId, {
            providerId: input.providerId,
            locationId: input.locationId,
          });
          const series = await tx.appointmentSeries.create({
            data: {
              tenantId,
              intervalWeeks: input.intervalWeeks,
              occurrences: input.slots.length,
              createdById: input.createdById,
            },
            select: { id: true },
          });
          const ids: string[] = [];
          for (const [position, slot] of input.slots.entries()) {
            try {
              // DX-149: un bloqueo creado a la vez ya se ve con el candado.
              if (
                await hardBlockOver(tx, {
                  providerId: input.providerId,
                  locationId: input.locationId,
                  start: slot.start,
                  end: slot.end,
                })
              ) {
                throw new ScheduleBlockedRaceError();
              }
              const created = await tx.appointment.create({
                data: {
                  tenantId,
                  locationId: input.locationId,
                  patientId: input.patientId,
                  providerId: input.providerId,
                  start: slot.start,
                  end: slot.end,
                  reason: input.reason,
                  notes: input.notes,
                  createdById: input.createdById,
                  appointmentTypeId: input.appointmentTypeId,
                  chairId: input.chairId,
                  seriesId: series.id,
                  seriesIndex: position + 1,
                },
                select: { id: true },
              });
              ids.push(created.id);
            } catch (error) {
              throw new SeriesSlotWriteError({ position }, error);
            }
          }
          // DX-556: «Cita agendada» del prospecto UNA vez por serie, con la
          // primera cita (la que se guarda como su primera cita).
          await leadsOnAppointmentCreatedInTx(tx, {
            tenantId,
            patientId: input.patientId,
            appointmentId: ids[0],
            actor: {
              actor: {
                userId: input.createdById,
                role: input.actorRole,
              },
              locationId: input.locationId,
              requestId: input.audit.requestId,
              ip: input.audit.ip,
              userAgent: input.audit.userAgent,
            },
          });
          await writeAuditEvent(tx, {
            tenantId,
            locationId: input.audit.locationId,
            actor: {
              kind: 'user',
              userId: input.audit.actor.userId,
              role: input.audit.actor.role,
            },
            action: 'CREATE',
            resourceType: 'APPOINTMENT',
            resourceId: ids[0],
            patient: { kind: 'patient', id: input.patientId },
            requestId: input.audit.requestId,
            ip: input.audit.ip,
            userAgent: input.audit.userAgent,
            metadata: {
              reason: 'APPOINTMENT_SERIES_CREATED',
              appointmentSeries: {
                seriesId: series.id,
                appointmentIds: ids,
                dates: input.slots.map((s) => s.start.toISOString()),
                intervalWeeks: input.intervalWeeks,
              },
            },
          });
          if (input.email) await input.email.insert(tx);
          const rows = await tx.appointment.findMany({
            where: { seriesId: series.id },
            orderBy: { seriesIndex: 'asc' },
            include: INCLUDE_PATIENT_NAME,
          });
          return { seriesId: series.id, appointments: rows.map(mapToEntity) };
        },
        { timeout: SERIES_TX_TIMEOUT_MS },
      ),
    );
  }

  applyChanges(input: ApplySeriesChangesInput): Promise<Appointment[]> {
    const tenantId = this.requireTenantId();
    return this.retryOnDeadlock(() =>
      this.prisma.runWithTenant(
        async (tx) => {
          if (input.lock) {
            await this.lockSeries(tx, tenantId);
            // Todos los profesionales primero (en orden) y luego la sede: el
            // mismo orden que lockAgenda de una cita suelta (profesional →
            // sede), sin ciclos.
            for (const providerId of [
              ...new Set(input.lock.providerIds),
            ].sort()) {
              await lockAgenda(tx, tenantId, { providerId, locationId: null });
            }
            await lockAgenda(tx, tenantId, {
              providerId: null,
              locationId: input.lock.locationId,
            });
          }
          const updated: Appointment[] = [];
          for (const change of input.changes) {
            try {
              const { appointment } = await this.appointments.updateInTx(
                tx,
                change.id,
                change.patch,
              );
              updated.push(appointment);
            } catch (error) {
              throw new SeriesSlotWriteError(
                { appointmentId: change.id },
                error,
              );
            }
          }
          if (input.markCancelledBy !== null) {
            const pending = await tx.appointment.count({
              where: {
                seriesId: input.seriesId,
                deletedAt: null,
                status: {
                  in: [
                    AppointmentStatus.SCHEDULED,
                    AppointmentStatus.CONFIRMED,
                  ],
                },
              },
            });
            if (pending === 0) {
              await tx.appointmentSeries.updateMany({
                where: { id: input.seriesId, cancelledAt: null },
                data: {
                  cancelledAt: new Date(),
                  cancelledById: input.markCancelledBy,
                },
              });
            }
          }
          if (updated.length > 0) {
            await writeAuditEvent(tx, input.auditEvent(updated));
          }
          return updated;
        },
        { timeout: SERIES_TX_TIMEOUT_MS },
      ),
    );
  }

  async noticeContext(input: {
    patientId: string;
    locationId: string;
    providerId: string;
  }): Promise<SeriesNoticeContext | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const [patient, location, tenant, provider] = await Promise.all([
        tx.patient.findFirst({
          where: { id: input.patientId },
          select: {
            firstName: true,
            birthDate: true,
            email: true,
            emergencyContactName: true,
            preferredLanguage: true,
            contactChannel: true,
            reminderOptOutAt: true,
          },
        }),
        tx.location.findFirst({
          where: { id: input.locationId },
          select: {
            id: true,
            name: true,
            timeZone: true,
            locale: true,
            hourCycle: true,
          },
        }),
        tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { name: true },
        }),
        tx.clinicMembership.findFirst({
          where: { userId: input.providerId },
          orderBy: { createdAt: 'desc' },
          select: { user: { select: { fullName: true } } },
        }),
      ]);
      if (!patient || !location?.timeZone) return null;
      const [responsibles, majorityReview, majorityAge] = await Promise.all([
        loadNoticeResponsibles(tx, input.patientId),
        loadMajorityReview(tx, input.patientId),
        loadTenantMajorityAge(tx, tenantId),
      ]);
      return {
        clinicName: tenant.name,
        locationName: location.name,
        locationTimeZone: requireLocationTimeZone(location),
        locationLocale: location.locale,
        locationHourCycle: location.hourCycle,
        providerName: provider?.user.fullName ?? null,
        preferredLanguage: patient.preferredLanguage,
        contact: {
          contactChannel: patient.contactChannel,
          reminderOptOutAt: patient.reminderOptOutAt,
          email: patient.email,
        },
        recipient: {
          firstName: patient.firstName,
          birthDate: patient.birthDate,
          email: patient.email,
          emergencyContactName: patient.emergencyContactName,
        },
        responsibles,
        majorityReview,
        majorityAge,
      };
    });
  }
}
