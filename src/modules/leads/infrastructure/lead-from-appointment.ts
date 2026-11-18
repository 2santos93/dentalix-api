import { Prisma } from '@prisma/client';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';

/**
 * DX-556: la cita mueve al prospecto. Lo llama el repositorio de citas DENTRO
 * de su transacción (como el alta en «Pendientes por agendar» de DX-122):
 * este fichero no importa nada de appointments y el módulo de prospectos no
 * importa el de citas, así que no hay acoplamiento circular.
 *
 *  - Cita creada para el paciente de un prospecto convertido que sigue en
 *    NEW o CONTACTED → SCHEDULED, con la fecha (la primera vez) y la primera
 *    cita (se fija una vez).
 *  - Cita atendida (→ COMPLETED) de ese paciente con el prospecto en
 *    SCHEDULED → ATTENDED.
 *
 * Una sentencia por conjunto (sin búsquedas por fila); el índice parcial
 * leads_converted_patient_idx acota la búsqueda al paciente. Un
 * `audit_event` UPDATE LEAD por prospecto movido, con el usuario de la cita.
 */

type Tx = Prisma.TransactionClient;

/** Quién mueve la cita: el usuario de la petición (sin él no se mueve nada). */
export type LeadAppointmentActor = Pick<
  AuditRequestContext,
  'actor' | 'locationId' | 'requestId' | 'ip' | 'userAgent'
>;

const NOW = Prisma.sql`pg_catalog.timezone('UTC', pg_catalog.now())`;

async function audit(
  tx: Tx,
  tenantId: string,
  moved: { id: string; from: string }[],
  to: 'SCHEDULED' | 'ATTENDED',
  patientId: string,
  appointmentId: string,
  ctx: LeadAppointmentActor,
): Promise<void> {
  for (const lead of moved) {
    await writeAuditEvent(tx, {
      tenantId,
      locationId: ctx.locationId,
      actor: {
        kind: 'user',
        userId: ctx.actor.userId,
        role: ctx.actor.role,
      },
      action: 'UPDATE',
      resourceType: 'LEAD',
      resourceId: lead.id,
      patient: { kind: 'patient', id: patientId },
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        reason: 'LEAD_STAGE_CHANGED',
        statusChange: { from: lead.from, to },
        params: { appointmentId },
      },
    });
  }
}

/** Cita nueva del paciente: sus prospectos abiertos pasan a «Cita agendada». */
export async function leadsOnAppointmentCreatedInTx(
  tx: Tx,
  input: {
    tenantId: string;
    patientId: string;
    appointmentId: string;
    actor: LeadAppointmentActor | null;
  },
): Promise<number> {
  if (!input.actor) return 0;
  const moved = await tx.$queryRaw<{ id: string; from: string }[]>`
    WITH old AS (
      SELECT "id", "stage"::text AS "from" FROM "leads"
       WHERE "tenantId" = ${input.tenantId}::uuid
         AND "patientId" = ${input.patientId}::uuid
         AND "stage" IN ('NEW', 'CONTACTED')
         AND "anonymizedAt" IS NULL
       FOR UPDATE
    )
    UPDATE "leads" l SET
      "stage" = 'SCHEDULED',
      "scheduledAt" = coalesce(l."scheduledAt", ${NOW}),
      "firstAppointmentId" = coalesce(l."firstAppointmentId", ${input.appointmentId}::uuid),
      "updatedAt" = ${NOW}
      FROM old
     WHERE l."id" = old."id"
    RETURNING l."id", old."from"`;
  await audit(
    tx,
    input.tenantId,
    moved,
    'SCHEDULED',
    input.patientId,
    input.appointmentId,
    input.actor,
  );
  return moved.length;
}

/** Cita atendida: los prospectos del paciente con cita pasan a «Asistió». */
export async function leadsOnAppointmentCompletedInTx(
  tx: Tx,
  input: {
    tenantId: string;
    patientId: string;
    appointmentId: string;
    actor: LeadAppointmentActor | null;
  },
): Promise<number> {
  if (!input.actor) return 0;
  const moved = await tx.$queryRaw<{ id: string; from: string }[]>`
    WITH old AS (
      SELECT "id", "stage"::text AS "from" FROM "leads"
       WHERE "tenantId" = ${input.tenantId}::uuid
         AND "patientId" = ${input.patientId}::uuid
         AND "stage" = 'SCHEDULED'
         AND "anonymizedAt" IS NULL
       FOR UPDATE
    )
    UPDATE "leads" l SET
      "stage" = 'ATTENDED',
      "attendedAt" = ${NOW},
      "updatedAt" = ${NOW}
      FROM old
     WHERE l."id" = old."id"
    RETURNING l."id", old."from"`;
  await audit(
    tx,
    input.tenantId,
    moved,
    'ATTENDED',
    input.patientId,
    input.appointmentId,
    input.actor,
  );
  return moved.length;
}
