-- DX-149: el panel de «Pendientes por agendar» sin recorrer pacientes.
--
-- 1. Un paciente archivado ya no tiene entradas OPEN: al archivarlo se cierran
--    (ver PrismaPatientRepository.archive). Aquí se cierran las que ya
--    existieran, con el mismo motivo, sin borrar ninguna fila. Por clínica:
--    appointment_waitlist tiene RLS con FORCE.
-- 2. Índice en el orden del panel (sede, estado, prioridad DESC, antigüedad,
--    id): la página sale del índice sin ordenar y el total cuenta solo las
--    OPEN de la sede. NO es parcial a propósito: Prisma manda el estado como
--    parámetro y, con el plan genérico de una sentencia preparada, Postgres no
--    puede usar un índice `WHERE "status" = 'OPEN'`. Sin CONCURRENTLY: `prisma
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

CREATE INDEX "appointment_waitlist_panel_idx"
  ON "appointment_waitlist" ("tenantId", "locationId", "status", "priority" DESC, "createdAt", "id");
