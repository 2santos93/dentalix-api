-- DX-161: una sola entrada OPEN de «Pendientes por agendar» por paciente.
--
-- Hasta ahora lo comprobaba solo la aplicación, y dos altas manuales a la vez
-- podían colar dos. Aditiva: antes del índice se resuelven los duplicados que
-- ya existan. De cada grupo (clínica, paciente) con varias OPEN se conserva la
-- más antigua tal cual; las demás pasan a DISMISSED con el motivo «Duplicada»
-- (no se borra ninguna fila: queda el rastro, con su hora de resolución).
-- Se recorre por clínica porque appointment_waitlist tiene RLS con FORCE.
SET lock_timeout = '5s';

DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    UPDATE public."appointment_waitlist" w
       SET "status" = 'DISMISSED',
           "dismissReason" = 'Duplicada: el paciente ya estaba pendiente (DX-161)',
           "resolvedAt" = CURRENT_TIMESTAMP,
           "updatedAt" = CURRENT_TIMESTAMP
      FROM (
        SELECT "id",
               row_number() OVER (
                 PARTITION BY "patientId" ORDER BY "createdAt", "id"
               ) AS n
          FROM public."appointment_waitlist"
         WHERE "tenantId" = t
           AND "status" = 'OPEN'
      ) d
     WHERE w."id" = d."id" AND d.n > 1;
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
END
$$;

CREATE UNIQUE INDEX "appointment_waitlist_open_patient_key"
  ON "appointment_waitlist" ("tenantId", "patientId")
  WHERE "status" = 'OPEN';
