import { Injectable } from '@nestjs/common';
import { DEFAULT_CALENDAR_ALARM_HOURS } from '../domain/reminder-lead-hours';
import {
  AppointmentReminderSkipReason,
  AppointmentReminderStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { lockRow } from '../../../shared/prisma/lock-row';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import {
  loadNoticeResponsibles,
  loadMajorityReview,
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

const HOUR_MS = 3_600_000;

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
  calendarAlarmHours: true,
  updatedAt: true,
} as const satisfies Prisma.LocationReminderSettingsSelect;

/** Una ventana del barrido: citas de la sede con `start` en (lo, hi]. */
export interface SweepWindow {
  locationId: string;
  leadHours: number;
  lo: Date;
  hi: Date;
}

/**
 * Por cada antelación de cada sede activa (y no retirada), el tramo de
 * `start` cuya hora de recordatorio cae en (now - catchUp, now + lookahead],
 * es decir `start` en (lo, hi] con lo = max(now, now + lead - catchUp) y
 * hi = now + lead + lookahead. Misma fórmula que isInSweepWindow.
 *
 * Una antelación repetida en el array da otra ventana igual, como daba el
 * `unnest` de antes (el handler deduplica por idempotencyKey).
 */
export async function loadSweepWindows(
  tx: Prisma.TransactionClient,
  tenantId: string,
  now: Date,
): Promise<SweepWindow[]> {
  const settings = await tx.locationReminderSettings.findMany({
    where: { tenantId, enabled: true, location: { deletedAt: null } },
    orderBy: { locationId: 'asc' },
    select: { locationId: true, leadHours: true },
  });
  const t = now.getTime();
  return settings.flatMap(({ locationId, leadHours }) =>
    leadHours.map((lead) => ({
      locationId,
      leadHours: lead,
      lo: new Date(Math.max(t, t + lead * HOUR_MS - REMINDER_CATCH_UP_MS)),
      hi: new Date(t + lead * HOUR_MS + REMINDER_LOOKAHEAD_MS),
    })),
  );
}

/**
 * Las citas de todas las ventanas, por hora de inicio: un SELECT por ventana
 * unidos con UNION ALL, cada uno con sus cotas como parámetros.
 *
 * DX-225 (DB-036): el barrido solo debe leer las citas de la ventana, con
 * `a."start" > lo AND a."start" <= hi` como rango sobre
 * appointments_tenant_location_start_idx (tenantId, locationId, start). La
 * versión anterior calculaba las ventanas en SQL (LATERAL `w` con `unnest`)
 * y buscaba las citas en otro LATERAL con `OFFSET 0`; las cotas eran
 * referencias externas y llegar al índice dependía del planificador:
 * Postgres 16.14/16.15 hacía un Index Scan con las dos cotas, pero 16.16
 * elige un Bitmap Heap Scan cuyo Bitmap Index Scan solo lleva
 * (tenantId, locationId) y recorre toda la agenda futura de la sede. Con las
 * ventanas calculadas antes (loadSweepWindows) y pasadas como constantes,
 * cualquier plan (Index Scan o Bitmap) las pone en el Index Cond.
 *
 * Todos los estados: el handler registra el motivo si la cita ya no va.
 * DX-128: sin los pacientes con baja o con canal distinto de EMAIL (regla
 * de reminder-eligibility.ts): esos nunca entran en la cola. El paciente
 * se lee por su PK (tenantId, id) desde cada cita. Exportada (con
 * loadSweepWindows) para que el int-spec explique (EXPLAIN) la consulta real.
 */
export function dueCandidatesSql(
  tenantId: string,
  windows: readonly SweepWindow[],
): Prisma.Sql {
  if (windows.length === 0) {
    throw new Error('dueCandidatesSql: sin ventanas no hay consulta');
  }
  const selects = windows.map(
    (w) => Prisma.sql`
    SELECT a."id" AS "appointmentId", ${w.leadHours}::int AS "leadHours", a."start"
      FROM "appointments" a
      JOIN "patients" p
        ON p."tenantId" = a."tenantId"
       AND p."id" = a."patientId"
     WHERE a."tenantId" = ${tenantId}::uuid
       AND a."locationId" = ${w.locationId}::uuid
       AND a."start" > ${utc(w.lo)}
       AND a."start" <= ${utc(w.hi)}
       AND a."deletedAt" IS NULL
       AND p."contactChannel" = 'EMAIL'
       AND p."reminderOptOutAt" IS NULL`,
  );
  return Prisma.sql`${Prisma.join(selects, '\n    UNION ALL')}
     ORDER BY "start"`;
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
          calendarAlarmHours:
            s?.calendarAlarmHours ?? DEFAULT_CALENDAR_ALARM_HOURS,
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
      // DX-360: la sede bloqueada (FOR NO KEY UPDATE) serializa dos guardados
      // a la vez, también el primero, cuando aún no hay fila de ajustes: el
      // antes de cada evento es el después del anterior.
      if (!(await lockRow(tx, 'locations', locationId, 'NO KEY UPDATE'))) {
        return null;
      }
      const location = await tx.location.findFirst({
        where: { id: locationId, deletedAt: null },
        select: {
          id: true,
          name: true,
          reminderSettings: {
            select: {
              enabled: true,
              leadHours: true,
              calendarAlarmHours: true,
            },
          },
        },
      });
      if (!location) return null;
      const data = {
        enabled: input.enabled,
        leadHours: input.leadHours,
        // DX-469: sin valor en el PUT se conserva (o el por defecto al crear).
        ...(input.calendarAlarmHours !== undefined
          ? { calendarAlarmHours: input.calendarAlarmHours }
          : {}),
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
        location.reminderSettings[0] ?? {
          enabled: false,
          leadHours: [],
          calendarAlarmHours: DEFAULT_CALENDAR_ALARM_HOURS,
        },
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
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const windows = await loadSweepWindows(tx, tenantId, now);
      if (windows.length === 0) return [];
      return tx.$queryRaw<ReminderCandidate[]>(
        dueCandidatesSql(tenantId, windows),
      );
    });
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
      const [settings, responsibles, majorityReview, policy, majorityAge] =
        await Promise.all([
          tx.locationReminderSettings.findFirst({
            where: { locationId: appointment.locationId },
            select: { enabled: true, leadHours: true },
          }),
          loadNoticeResponsibles(tx, appointment.patient.id),
          loadMajorityReview(tx, appointment.patient.id),
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
        majorityReview,
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
