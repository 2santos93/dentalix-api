import { Prisma } from '@prisma/client';

/**
 * DX-149: candados de la agenda para que una cita y un bloqueo simultáneos no
 * se crucen sin confirmación. La comprobación «¿hay un bloqueo encima?» (cita)
 * y «¿hay citas debajo?» (bloqueo) se hace en transacciones distintas de la
 * escritura; con estos candados, la segunda transacción espera a la primera y
 * vuelve a mirar dentro de la suya.
 *
 * - Cita: candado del profesional y de la sede, en ese orden.
 * - Bloqueo de un profesional: el del profesional (toda cita suya lo toma).
 * - Bloqueo de toda la sede: el de la sede (toda cita de la sede lo toma).
 *
 * Las claves salen del tenant del contexto y de ids ya validados por el caso de
 * uso, nunca de texto libre del usuario. Mismo orden siempre: sin ciclos.
 */
export async function lockAgenda(
  tx: Prisma.TransactionClient,
  tenantId: string,
  scope: { providerId: string | null; locationId: string | null },
): Promise<void> {
  if (scope.providerId !== null) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(
      hashtext(${'dx_agenda_provider:' + tenantId}),
      hashtext(${scope.providerId})
    )`;
  }
  if (scope.locationId !== null) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(
      hashtext(${'dx_agenda_location:' + tenantId}),
      hashtext(${scope.locationId})
    )`;
  }
}

/**
 * ¿Hay un bloqueo vivo que NO deja agendar (no reservado) encima de la cita?
 * Mismo alcance que `blockAffects`: el de la sede entera, o el del profesional
 * en esa sede o en todas. Los huecos reservados (DX-446) no entran: su regla
 * depende del tipo, del reloj y del permiso, y la decide el caso de uso.
 */
export async function hardBlockOver(
  tx: Prisma.TransactionClient,
  slot: { providerId: string; locationId: string; start: Date; end: Date },
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "schedule_blocks"
     WHERE "deletedAt" IS NULL
       AND "allowsBooking" = false
       AND "kind" <> 'RESERVED'
       AND "start" < ${slot.end}
       AND "end" > ${slot.start}
       AND (("providerId" IS NULL AND "locationId" = ${slot.locationId}::uuid)
         OR ("providerId" = ${slot.providerId}::uuid
             AND ("locationId" IS NULL OR "locationId" = ${slot.locationId}::uuid)))
     LIMIT 1`;
  return rows.length > 0;
}
