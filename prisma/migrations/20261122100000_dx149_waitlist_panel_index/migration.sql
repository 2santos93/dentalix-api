-- DX-149: el panel de «Pendientes por agendar» sin recorrer pacientes.
--
-- 1. Un paciente archivado ya no tiene entradas OPEN: al archivarlo se cierran
--    (ver PrismaPatientRepository.archive). Aquí se cierran las que ya
--    existieran, con el mismo motivo, sin borrar ninguna fila. Por clínica:
--    appointment_waitlist tiene RLS con FORCE.
-- 2. Índice PARCIAL del panel (OPEN) en su orden: sede, prioridad DESC,
--    antigüedad, id. La página sale del índice sin ordenar y el total cuenta
--    solo las OPEN. Bajo RLS la igualdad de un enum no es LEAKPROOF: Postgres
--    solo lo usa con 'OPEN' LITERAL en la consulta (ver
--    PrismaWaitlistRepository.listOpen), no con el estado como parámetro.
--    Medido con 60.000 pacientes y 40.000 entradas: de 12-15 ms (Seq Scan) a
--    0,1 ms. El WHERE no lo expresa Prisma: schema.prisma declara el índice
--    sin él, con el mismo nombre y columnas (no hay drift; no aceptes que un
--    `migrate dev` futuro lo convierta en completo). Sin CONCURRENTLY: `prisma
--    migrate deploy` ejecuta cada migración en una transacción (mismo criterio
--    que 20261015120000_payments_tenant_location_paidat_index).
SET lock_timeout = '5s';

DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    UPDATE public."appointment_waitlist" w
       SET "status" = 'DISMISSED',
           "dismissReason" = 'Paciente archivado',
           "resolvedAt" = CURRENT_TIMESTAMP,
           "updatedAt" = CURRENT_TIMESTAMP
      FROM public."patients" p
     WHERE w."tenantId" = t
       AND w."status" = 'OPEN'
       AND p."id" = w."patientId"
       AND p."deletedAt" IS NOT NULL;
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
END
$$;

CREATE INDEX "appointment_waitlist_open_panel_idx"
  ON "appointment_waitlist" ("tenantId", "locationId", "priority" DESC, "createdAt", "id")
  WHERE "status" = 'OPEN';
