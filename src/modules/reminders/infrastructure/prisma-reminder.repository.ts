import { Injectable } from '@nestjs/common';
import {
  AppointmentReminderSkipReason,
  AppointmentReminderStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { loadLocationTimeZones } from '../../../shared/locations/location-time-zone';
import { DEFAULT_BUSINESS_HOURS_TIMEZONE } from '../../../shared/locations/default-business-hours';
import { loadNoticeResponsibles } from '../../patients/infrastructure/notices/notice-context';
import {
  REMINDER_CATCH_UP_MS,
  REMINDER_LOOKAHEAD_MS,
} from '../domain/reminder-window';
import type { ReminderSettingsInput } from '../domain/reminder-lead-hours';
import type { ReminderEmailDelivery } from '../domain/reminder-timeline';
import type { ReminderContact } from '../domain/reminder-eligibility';
import type {
  AppointmentRemindersSnapshot,
  LocationReminderSettingsView,
  ReminderCandidate,
  ReminderClaim,
  ReminderRepository,
  ReminderSendContext,
} from '../domain/ports/reminder-repository.port';

/** Las columnas son TIMESTAMP(3) en UTC (sin zona), como el resto del esquema. */
const utc = (d: Date) =>
  Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/** Lo que decide si el paciente recibe el email automático (DX-128). */
const CONTACT_SELECT = {
  id: true,
  email: true,
  contactChannel: true,
  reminderOptOutAt: true,
} as const satisfies Prisma.PatientSelect;

function toContact(
  patient: Prisma.PatientGetPayload<{ select: typeof CONTACT_SELECT }>,
): ReminderContact {
  return {
    contactChannel: patient.contactChannel,
    reminderOptOutAt: patient.reminderOptOutAt,
    email: patient.email,
  };
}

const SETTINGS_SELECT = {
  enabled: true,
  leadHours: true,
  updatedAt: true,
} as const satisfies Prisma.LocationReminderSettingsSelect;

@Injectable()
export class PrismaReminderRepository implements ReminderRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  listSettings(): Promise<LocationReminderSettingsView[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const locations = await tx.location.findMany({
        where: { deletedAt: null },
        orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          reminderSettings: { select: SETTINGS_SELECT },
        },
      });
      return locations.map((l) => {
        const s = l.reminderSettings[0];
        return {
          locationId: l.id,
          locationName: l.name,
          enabled: s?.enabled ?? false,
          leadHours: s?.leadHours ?? [],
          updatedAt: s?.updatedAt ?? null,
        };
      });
    });
  }

  saveSettings(
    locationId: string,
    input: ReminderSettingsInput,
    updatedById?: string,
  ): Promise<LocationReminderSettingsView | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Bajo RLS: una sede de otra clínica es invisible, igual que una que no existe.
      const location = await tx.location.findFirst({
        where: { id: locationId, deletedAt: null },
        select: { id: true, name: true },
      });
      if (!location) return null;
      const data = {
        enabled: input.enabled,
        leadHours: input.leadHours,
        updatedById: updatedById ?? null,
      };
      const saved = await tx.locationReminderSettings.upsert({
        where: { tenantId_locationId: { tenantId, locationId } },
        create: { tenantId, locationId, ...data },
        update: data,
        select: SETTINGS_SELECT,
      });
      return {
        locationId: location.id,
        locationName: location.name,
        ...saved,
      };
    });
  }

  async tenantIds(): Promise<string[]> {
    const rows = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  dueCandidates(tenantId: string, now: Date): Promise<ReminderCandidate[]> {
    const lookahead = REMINDER_LOOKAHEAD_MS / 1000;
    const catchUp = REMINDER_CATCH_UP_MS / 1000;
    // Por cada antelación de cada sede activa, el tramo de `start` cuya hora
    // de recordatorio cae en (now - catchUp, now + lookahead]: lo sirve
    // appointments_tenant_location_start_idx (tenantId, locationId, start).
    // Todos los estados: el handler registra el motivo si la cita ya no va.
    // DX-128: sin los pacientes con baja o con canal distinto de EMAIL (regla
    // de reminder-eligibility.ts): esos nunca entran en la cola. El paciente
    // se lee por su PK (tenantId, id) desde cada cita.
    return this.prisma.runWithTenant(
      tenantId,
      (tx) => tx.$queryRaw<ReminderCandidate[]>`
        SELECT a."id" AS "appointmentId", lead AS "leadHours", a."start"
          FROM "location_reminder_settings" rs
          CROSS JOIN LATERAL unnest(rs."leadHours") AS lead
          JOIN "appointments" a
            ON a."tenantId" = rs."tenantId"
           AND a."locationId" = rs."locationId"
          JOIN "patients" p
            ON p."tenantId" = a."tenantId"
           AND p."id" = a."patientId"
         WHERE rs."tenantId" = ${tenantId}::uuid
           AND rs."enabled"
           AND a."deletedAt" IS NULL
           AND p."contactChannel" = 'EMAIL'
           AND p."reminderOptOutAt" IS NULL
           AND a."start" > ${utc(now)}
           AND a."start" <= ${utc(now)} + make_interval(hours => lead, secs => ${lookahead})
           AND a."start" > ${utc(now)} + make_interval(hours => lead, secs => ${-catchUp})
         ORDER BY a."start"`,
    );
  }

  loadSendContext(appointmentId: string): Promise<ReminderSendContext | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // RLS: una cita de otra clínica (un id manipulado en el payload) no
      // aparece. Se leen también las retiradas para registrar el motivo.
      const appointment = await tx.appointment.findFirst({
        where: { id: appointmentId },
        select: {
          id: true,
          start: true,
          status: true,
          deletedAt: true,
          locationId: true,
          patient: {
            select: {
              ...CONTACT_SELECT,
              firstName: true,
              birthDate: true,
              emergencyContactName: true,
            },
          },
          location: { select: { country: true } },
        },
      });
      if (!appointment) return null;
      const [settings, zones, responsibles] = await Promise.all([
        tx.locationReminderSettings.findFirst({
          where: { locationId: appointment.locationId },
          select: { enabled: true, leadHours: true },
        }),
        loadLocationTimeZones(tx, tenantId, [appointment.locationId]),
        loadNoticeResponsibles(tx, appointment.patient.id),
      ]);
      return {
        appointment: {
          id: appointment.id,
          start: appointment.start,
          status: appointment.status,
          deleted: appointment.deletedAt !== null,
        },
        locationCountry: appointment.location.country,
        locationTimeZone:
          zones.get(appointment.locationId) ?? DEFAULT_BUSINESS_HOURS_TIMEZONE,
        patientId: appointment.patient.id,
        contact: toContact(appointment.patient),
        recipient: {
          firstName: appointment.patient.firstName,
          birthDate: appointment.patient.birthDate,
          email: appointment.patient.email,
          emergencyContactName: appointment.patient.emergencyContactName,
        },
        responsibles,
        settings,
      };
    });
  }

  async recordSkipped(
    appointmentId: string,
    leadHours: number,
    start: Date,
    reason: AppointmentReminderSkipReason,
  ): Promise<boolean> {
    // Un SENDING que nunca llegó a crear su mensaje (intento caído antes) pasa
    // a omitido; uno terminado no cambia.
    const n = await this.prisma.runWithTenant(
      (tx) => tx.$executeRaw`
        INSERT INTO "appointment_reminders"
          ("id", "tenantId", "appointmentId", "leadHours", "appointmentStart",
           "status", "skipReason", "updatedAt")
        VALUES
          (gen_random_uuid(), current_setting('app.current_tenant', true)::uuid,
           ${appointmentId}::uuid, ${leadHours}, ${utc(start)},
           'SKIPPED', ${reason}::"AppointmentReminderSkipReason", CURRENT_TIMESTAMP)
        ON CONFLICT ("tenantId", "appointmentId", "leadHours", "appointmentStart")
        DO UPDATE SET "status" = 'SKIPPED', "skipReason" = EXCLUDED."skipReason",
                      "updatedAt" = CURRENT_TIMESTAMP
         WHERE "appointment_reminders"."status" = 'SENDING'
           AND "appointment_reminders"."outboundMessageId" IS NULL`,
    );
    return n > 0;
  }

  claim(
    appointmentId: string,
    leadHours: number,
    start: Date,
  ): Promise<ReminderClaim> {
    return this.prisma.runWithTenant(async (tx) => {
      const inserted = await tx.$queryRaw<ReminderClaim[]>`
        INSERT INTO "appointment_reminders"
          ("id", "tenantId", "appointmentId", "leadHours", "appointmentStart",
           "status", "updatedAt")
        VALUES
          (gen_random_uuid(), current_setting('app.current_tenant', true)::uuid,
           ${appointmentId}::uuid, ${leadHours}, ${utc(start)},
           'SENDING', CURRENT_TIMESTAMP)
        ON CONFLICT ("tenantId", "appointmentId", "leadHours", "appointmentStart")
        DO NOTHING
        RETURNING "id", "status", "outboundMessageId"`;
      if (inserted.length > 0) return inserted[0];
      return tx.appointmentReminder.findFirstOrThrow({
        where: { appointmentId, leadHours, appointmentStart: start },
        select: { id: true, status: true, outboundMessageId: true },
      });
    });
  }

  async attachOutbound(
    reminderId: string,
    outboundMessageId: string,
  ): Promise<void> {
    await this.prisma.runWithTenant((tx) =>
      tx.appointmentReminder.updateMany({
        where: {
          id: reminderId,
          status: AppointmentReminderStatus.SENDING,
          outboundMessageId: null,
        },
        data: { outboundMessageId },
      }),
    );
  }

  async emailQueuedFor(outboundMessageId: string): Promise<boolean> {
    const n = await this.prisma.runWithTenant((tx) =>
      tx.emailOutbox.count({ where: { referenceId: outboundMessageId } }),
    );
    return n > 0;
  }

  async markSent(reminderId: string, sentAt: Date): Promise<void> {
    await this.prisma.runWithTenant((tx) =>
      tx.appointmentReminder.updateMany({
        where: { id: reminderId, status: AppointmentReminderStatus.SENDING },
        data: { status: AppointmentReminderStatus.SENT, sentAt },
      }),
    );
  }

  findAppointmentReminders(
    appointmentId: string,
  ): Promise<AppointmentRemindersSnapshot | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const appointment = await tx.appointment.findFirst({
        where: { id: appointmentId, deletedAt: null },
        select: {
          start: true,
          status: true,
          locationId: true,
          patient: { select: CONTACT_SELECT },
        },
      });
      if (!appointment) return null;
      const [settings, records] = await Promise.all([
        tx.locationReminderSettings.findFirst({
          where: { locationId: appointment.locationId },
          select: { enabled: true, leadHours: true },
        }),
        tx.appointmentReminder.findMany({
          where: { appointmentId },
          select: {
            leadHours: true,
            appointmentStart: true,
            status: true,
            skipReason: true,
            sentAt: true,
            outboundMessageId: true,
            outboundMessage: { select: { recipientKind: true } },
          },
        }),
      ]);
      const outboundIds = records
        .map((r) => r.outboundMessageId)
        .filter((id): id is string => id !== null);
      // Entrega del email: el último envío de cada mensaje (índice
      // (tenantId, referenceId, createdAt DESC) de email_outbox).
      const emails = outboundIds.length
        ? await tx.emailOutbox.findMany({
            where: { referenceId: { in: outboundIds } },
            orderBy: { createdAt: 'desc' },
            select: { referenceId: true, status: true },
          })
        : [];
      const delivery = new Map<string, ReminderEmailDelivery>();
      for (const e of emails) {
        if (!e.referenceId || delivery.has(e.referenceId)) continue;
        delivery.set(
          e.referenceId,
          e.status === 'SENDING' ? 'PENDING' : e.status,
        );
      }
      return {
        appointment: {
          start: appointment.start,
          status: appointment.status,
          deleted: false,
        },
        settings,
        contact: toContact(appointment.patient),
        records: records.map((r) => ({
          leadHours: r.leadHours,
          appointmentStart: r.appointmentStart,
          status: r.status,
          skipReason: r.skipReason,
          sentAt: r.sentAt,
          emailDelivery: r.outboundMessageId
            ? (delivery.get(r.outboundMessageId) ?? null)
            : null,
          sentToResponsible: r.outboundMessage?.recipientKind === 'RESPONSIBLE',
        })),
      };
    });
  }
}
