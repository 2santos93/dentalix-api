import { Prisma } from '@prisma/client';

/**
 * DX-588: da a la cita `appointmentId` el turno siguiente de su sede en el
 * día civil de la cita (zona de la sede), y lo devuelve.
 *
 * Un solo `INSERT … ON CONFLICT DO UPDATE … RETURNING` sobre
 * `location_turn_counters`: la fila del contador queda bloqueada hasta el
 * COMMIT, así que dos recepciones que marcan «Llegó» a la vez en la misma
 * sede reciben números distintos; si la transacción de quien llama falla, el
 * contador no sube. Los números no se reutilizan (deshacer una llegada deja
 * un hueco): ningún otro turno cambia mientras dure su visita.
 *
 * El día es el de `start` en la zona de la sede (la llegada solo se marca el
 * día de la cita, y el tablero lista las citas de ese día). Una sede sin zona
 * no llega aquí (el caso de uso ya exige una válida); el COALESCE es solo la
 * red para no tumbar una llegada por el turno.
 *
 * Va dentro de la transacción de quien llama (RLS por `app.current_tenant`)
 * y con la fila de la cita ya escrita en ARRIVED.
 */
export async function assignTurnNumber(
  tx: Prisma.TransactionClient,
  tenantId: string,
  appointmentId: string,
): Promise<number | null> {
  const rows = await tx.$queryRaw<{ turnNumber: number }[]>`
    WITH counter AS (
      INSERT INTO "location_turn_counters"
             ("tenantId", "locationId", "day", "lastNumber", "updatedAt")
      SELECT a."tenantId", a."locationId",
             ((a."start" AT TIME ZONE 'UTC')
               AT TIME ZONE COALESCE(l."timeZone", 'UTC'))::date,
             1, timezone('UTC', now())
        FROM "appointments" a
        JOIN "locations" l
          ON l."tenantId" = a."tenantId" AND l."id" = a."locationId"
       WHERE a."id" = ${appointmentId}::uuid
         AND a."tenantId" = ${tenantId}::uuid
      ON CONFLICT ("tenantId", "locationId", "day") DO UPDATE
         SET "lastNumber" = "location_turn_counters"."lastNumber" + 1,
             "updatedAt" = timezone('UTC', now())
      RETURNING "lastNumber"
    )
    UPDATE "appointments"
       SET "turnNumber" = (SELECT "lastNumber" FROM counter)
     WHERE "id" = ${appointmentId}::uuid
       AND "tenantId" = ${tenantId}::uuid
    RETURNING "turnNumber"`;
  return rows[0]?.turnNumber ?? null;
}
