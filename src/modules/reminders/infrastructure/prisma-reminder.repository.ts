import { Injectable } from '@nestjs/common';
import {
  AppointmentReminderSkipReason,
  AppointmentReminderStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import {
  loadNoticeResponsibles,
  loadTenantMajorityAge,
} from '../../patients/infrastructure/notices/notice-context';
import {
  REMINDER_CATCH_UP_MS,
  REMINDER_LOOKAHEAD_MS,
} from '../domain/reminder-window';
import type { ReminderSettingsInput } from '../domain/reminder-lead-hours';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { reminderSettingsAuditEvent } from '../domain/reminder-settings-audit';
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

/**
 * Por cada antelación de cada sede activa (y no retirada), el tramo de
 * `start` cuya hora de recordatorio cae en (now - catchUp, now + lookahead],
 * es decir `start` en (lo, hi] con lo = max(now, now + lead - catchUp) y
 * hi = now + lead + lookahead.
 *
 * DX-225 (DB-036): cada ventana se calcula ANTES (LATERAL `w`) y la cita se
 * busca en otro LATERAL con `OFFSET 0`, que el planificador no aplana: así
 * `a."start" > w.lo AND a."start" <= w.hi` es un rango parametrizado sobre
 * appointments_tenant_location_start_idx (tenantId, locationId, start), y
 * solo se leen las citas de la ventana. Con las cotas en el JOIN, el plan
 * recorría todas las citas futuras de la sede y las descartaba después.
 *
 * Todos los estados: el handler registra el motivo si la cita ya no va.
 * DX-128: sin los pacientes con baja o con canal distinto de EMAIL (regla
 * de reminder-eligibility.ts): esos nunca entran en la cola. El paciente
 * se lee por su PK (tenantId, id) desde cada cita. Exportada para que el
 * int-spec explique (EXPLAIN) la consulta real.
 */
export function dueCandidatesSql(tenantId: string, now: Date): Prisma.Sql {
  const lookahead = REMINDER_LOOKAHEAD_MS / 1000;
  const catchUp = REMINDER_CATCH_UP_MS / 1000;
  return Prisma.sql`
    SELECT c."appointmentId", w.lead AS "leadHours", c."start"
      FROM "location_reminder_settings" rs
      JOIN "locations" l
        ON l."tenantId" = rs."tenantId"
       AND l."id" = rs."locationId"
       AND l."deletedAt" IS NULL
      CROSS JOIN LATERAL (
        SELECT lead,
               GREATEST(${utc(now)},
                        ${utc(now)} + make_interval(hours => lead, secs => ${-catchUp})) AS lo,
               ${utc(now)} + make_interval(hours => lead, secs => ${lookahead}) AS hi
          FROM unnest(rs."leadHours") AS lead
      ) w
      CROSS JOIN LATERAL (
        SELECT a."id" AS "appointmentId", a."start"
          FROM "appointments" a
          JOIN "patients" p
            ON p."tenantId" = a."tenantId"
           AND p."id" = a."patientId"
         WHERE a."tenantId" = rs."tenantId"
           AND a."locationId" = rs."locationId"
           AND a."start" > w.lo
           AND a."start" <= w.hi
           AND a."deletedAt" IS NULL
           AND p."contactChannel" = 'EMAIL'
           AND p."reminderOptOutAt" IS NULL
        OFFSET 0
      ) c
     WHERE rs."tenantId" = ${tenantId}::uuid
       AND rs."enabled"
     ORDER BY c."start"`;
}

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
    audit: AuditRequestContext,
  ): Promise<LocationReminderSettingsView | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Bajo RLS: una sede de otra clínica es invisible, igual que una que no existe.
      const location = await tx.location.findFirst({
        where: { id: locationId, deletedAt: null },
        select: {
          id: true,
          name: true,
          reminderSettings: { select: { enabled: true, leadHours: true } },
        },
      });
      if (!location) return null;
      const data = {
        enabled: input.enabled,
        leadHours: input.leadHours,
        updatedById: audit.actor.userId,
      };
      const saved = await tx.locationReminderSettings.upsert({
        where: { tenantId_locationId: { tenantId, locationId } },
        create: { tenantId, locationId, ...data },
        update: data,
        select: SETTINGS_SELECT,
      });
      const event = reminderSettingsAuditEvent(
        audit,
        locationId,
        location.reminderSettings[0] ?? { enabled: false, leadHours: [] },
        saved,
      );
      if (event) await writeAuditEvent(tx, event);
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
    return this.prisma.runWithTenant(tenantId, (tx) =>
      tx.$queryRaw<ReminderCandidate[]>(dueCandidatesSql(tenantId, now)),
    );
  }

  loadSendContext(appointmentId: string): Promise<ReminderSendContext | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // RLS: una cita de otra clínica (un id manipulado en el payload) no
      // aparece. Se leen también las retiradas para registrar el motivo.
      const appointment = await tx.appointment.findFirst({
        where: { id: appointmentId, tenantId },
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
          location: {
            select: {
              id: true,
              timeZone: true,
              locale: true,
              hourCycle: true,
            },
          },
        },
      });
      if (!appointment) return null;
      const [settings, responsibles, policy, majorityAge] = await Promise.all([
        tx.locationReminderSettings.findFirst({
          where: { locationId: appointment.locationId },
          select: { enabled: true, leadHours: true },
        }),
        loadNoticeResponsibles(tx, appointment.patient.id),
        // DX-291: la política vigente de la sede, para el email.
        tx.cancellationPolicyVersion.findFirst({
          where: { locationId: appointment.locationId },
          orderBy: { version: 'desc' },
          select: {
            id: true,
            version: true,
            noticeHours: true,
            patientText: true,
            suggestedFee: true,
            currency: true,
          },
        }),
        // DX-328: la vigente al enviarse, no la de cuando se encoló.
        loadTenantMajorityAge(tx, tenantId),
      ]);
      return {
        appointment: {
          id: appointment.id,
          start: appointment.start,
          status: appointment.status,
          deleted: appointment.deletedAt !== null,
        },
        majorityAge,
        locationTimeZone: requireLocationTimeZone(appointment.location),
        // Después de la zona (su 409 gana): sin formato o sin reloj, el 409
        // de formato y el envío no sale, igual que con una zona NULL.
        locationFormat: requireLocationFormat(appointment.location),
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
        cancellationPolicy: policy
          ? {
              ...policy,
              suggestedFee:
                policy.suggestedFee === null
                  ? null
                  : policy.suggestedFee.toNumber(),
            }
          : null,
      };
    });
  }

  async recordPolicyVersion(
    reminderId: string,
    appointmentId: string,
    policyVersionId: string,
  ): Promise<void> {
    await this.prisma.runWithTenant(async (tx) => {
      await tx.appointmentReminder.updateMany({
        where: { id: reminderId, appointmentId },
        data: { policyVersionId },
      });
      await tx.appointment.updateMany({
        where: { id: appointmentId },
        data: { policyVersionId },
      });
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
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const attach = async (transaction: Prisma.TransactionClient) => {
      const { count } = await transaction.appointmentReminder.updateMany({
        where: {
          id: reminderId,
          status: AppointmentReminderStatus.SENDING,
          outboundMessageId: null,
        },
        data: { outboundMessageId },
      });
      // No sustituir un mensaje ya asociado ni tocar estados finales/otro tenant.
      if (count !== 1) throw new Error('ReminderOutboundNotAttachable');
    };
    if (tx) await attach(tx);
    else await this.prisma.runWithTenant(attach);
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

  async markFailed(
    appointmentId: string,
    leadHours: number,
    start: Date,
    errorCode: string,
    now: Date,
  ): Promise<void> {
    await this.prisma.runWithTenant(async (tx) => {
      // Un fallo al leer contexto puede ocurrir antes de claim. Solo una cita
      // visible bajo RLS permite crear este registro; nunca una cita ajena.
      await tx.$executeRaw`
        INSERT INTO "appointment_reminders"
          ("id", "tenantId", "appointmentId", "leadHours", "appointmentStart", "status", "updatedAt")
        SELECT gen_random_uuid(), "tenantId", "id", ${leadHours}, ${utc(start)}, 'SENDING', CURRENT_TIMESTAMP
          FROM "appointments" WHERE "id" = ${appointmentId}::uuid AND "deletedAt" IS NULL
        ON CONFLICT ("tenantId", "appointmentId", "leadHours", "appointmentStart") DO NOTHING`;
      const [reminder] = await tx.$queryRaw<
        { id: string; outboundMessageId: string | null }[]
      >`
        SELECT "id", "outboundMessageId" FROM "appointment_reminders"
        WHERE "appointmentId" = ${appointmentId}::uuid AND "leadHours" = ${leadHours}
          AND "appointmentStart" = ${utc(start)} AND "status" = 'SENDING'
        FOR UPDATE`;
      if (!reminder) return;
      const outboundId = reminder.outboundMessageId;
      const queued = outboundId
        ? (await tx.emailOutbox.count({
            where: { referenceId: outboundId },
          })) > 0
        : false;
      await tx.appointmentReminder.update({
        where: { id: reminder.id },
        data: {
          ...(queued
            ? { status: 'SENT', sentAt: now }
            : { status: 'FAILED', failureReason: errorCode }),
        },
      });
      if (outboundId) {
        await tx.outboundMessage.updateMany({
          where: {
            id: outboundId,
            status: { in: queued ? ['PENDING'] : ['PENDING', 'QUEUED'] },
          },
          data: queued
            ? { status: 'QUEUED' }
            : {
                status: 'FAILED',
                lastError: errorCode,
                attempts: { increment: 1 },
              },
        });
      }
    });
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
            failureReason: true,
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
        locationId: appointment.locationId,
        settings,
        contact: toContact(appointment.patient),
        records: records.map((r) => ({
          leadHours: r.leadHours,
          appointmentStart: r.appointmentStart,
          status: r.status,
          skipReason: r.skipReason,
          failureReason: r.failureReason,
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
