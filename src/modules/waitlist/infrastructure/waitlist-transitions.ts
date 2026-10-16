import { Prisma, WaitlistStatus } from '@prisma/client';

/**
 * Pasos de «Pendientes por agendar» (DX-122) que corren DENTRO de la
 * transacción de otro repositorio (citas, confirmaciones): así el cambio de la
 * cita y el de la lista se confirman o se deshacen juntos.
 */

/**
 * Alta automática de la cita `appointmentId` (recién CANCELLED o NO_SHOW) en
 * la lista, con su sede, paciente, profesional, tipo y duración. Idempotente:
 * el único parcial `("tenantId", "sourceAppointmentId")` hace que una segunda
 * llamada (el estado cambia otra vez, o dos peticiones compiten) no inserte
 * nada. Devuelve el id nuevo, o `null` si la cita ya tenía su entrada.
 *
 * SQL a mano porque Prisma no expresa `INSERT … SELECT … ON CONFLICT DO
 * NOTHING` contra un índice parcial. Corre bajo la RLS del tenant: la cita y
 * la fila nueva son de `app.current_tenant`.
 */
export async function enqueueWaitlistFromAppointment(
  tx: Prisma.TransactionClient,
  appointmentId: string,
  createdById: string | null,
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "appointment_waitlist" (
      "id", "tenantId", "locationId", "patientId", "sourceAppointmentId",
      "providerId", "appointmentTypeId", "durationMinutes", "createdById",
      "updatedAt"
    )
    SELECT gen_random_uuid(), a."tenantId", a."locationId", a."patientId", a."id",
           a."providerId", a."appointmentTypeId",
           LEAST(480, GREATEST(5,
             (round(extract(epoch FROM (a."end" - a."start")) / 300) * 5)::int)),
           ${createdById}::uuid, CURRENT_TIMESTAMP
      FROM "appointments" a
     WHERE a."id" = ${appointmentId}::uuid
       AND a."deletedAt" IS NULL
    ON CONFLICT ("tenantId", "sourceAppointmentId")
      WHERE "sourceAppointmentId" IS NOT NULL
      DO NOTHING
    RETURNING "id"`;
  return rows[0]?.id ?? null;
}

/**
 * La cita `appointmentId` resuelve la entrada `entryId`: pasa a SCHEDULED solo
 * si sigue OPEN (el UPDATE condicional es el árbitro si dos personas agendan
 * la misma entrada a la vez). `false` si ya no estaba abierta.
 */
export async function markWaitlistEntryScheduled(
  tx: Prisma.TransactionClient,
  entryId: string,
  appointmentId: string,
  resolvedById: string | null,
): Promise<boolean> {
  const { count } = await tx.appointmentWaitlistEntry.updateMany({
    where: { id: entryId, status: WaitlistStatus.OPEN },
    data: {
      status: WaitlistStatus.SCHEDULED,
      resolvedAppointmentId: appointmentId,
      resolvedById,
      resolvedAt: new Date(),
    },
  });
  return count === 1;
}

/**
 * La cita `appointmentId` dejó de estar cancelada o no-show (revisión H1): su
 * entrada OPEN, si la hay, pasa a SCHEDULED resuelta por la propia cita. Así el
 * paciente sale de «Pendientes» y nadie le agenda una segunda cita. Devuelve el
 * id de la entrada cerrada, o `null`.
 */
export async function resolveWaitlistForReactivated(
  tx: Prisma.TransactionClient,
  appointmentId: string,
  resolvedById: string | null,
): Promise<string | null> {
  const open = await tx.appointmentWaitlistEntry.findFirst({
    where: { sourceAppointmentId: appointmentId, status: WaitlistStatus.OPEN },
    select: { id: true },
  });
  if (!open) return null;
  const { count } = await tx.appointmentWaitlistEntry.updateMany({
    where: { id: open.id, status: WaitlistStatus.OPEN },
    data: {
      status: WaitlistStatus.SCHEDULED,
      resolvedAppointmentId: appointmentId,
      resolvedById,
      resolvedAt: new Date(),
    },
  });
  return count === 1 ? open.id : null;
}
