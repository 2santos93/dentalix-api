import { Prisma } from '@prisma/client';

/**
 * ¿El horario `s` (fila de `provider_schedules`) es capacidad? Solo si su
 * profesional sigue en el equipo (membresía y usuario vivos), atiende
 * (DENTIST o ADMIN, `ATTENDING_ROLES`) y puede atender en ESA sede (DX-089:
 * ADMIN o sin sedes asignadas = todas; si no, una de las suyas). Es el mismo
 * roster que la pantalla de horarios: el horario de quien se desactivó o dejó
 * de atender allí sigue vivo en la tabla, pero nadie lo ve ni lo puede retirar.
 * Lo comparten «Comparar sedes» (DX-305) y «Tiempos» (DX-275).
 */
export const attendingSchedule = Prisma.sql`EXISTS (
  SELECT 1
    FROM "clinic_memberships" m
    JOIN "users" u ON u."id" = m."userId" AND u."deletedAt" IS NULL
   WHERE m."tenantId" = s."tenantId"
     AND m."userId" = s."providerId"
     AND m."deletedAt" IS NULL
     AND m."role" IN ('DENTIST', 'ADMIN')
     AND (m."role" = 'ADMIN'
          OR NOT EXISTS (
            SELECT 1 FROM "membership_locations" ml
             WHERE ml."tenantId" = m."tenantId" AND ml."membershipId" = m."id")
          OR EXISTS (
            SELECT 1 FROM "membership_locations" ml
             WHERE ml."tenantId" = m."tenantId" AND ml."membershipId" = m."id"
               AND ml."locationId" = s."locationId"))
)`;
