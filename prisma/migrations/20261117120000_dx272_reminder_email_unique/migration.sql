-- DX-272: un solo email de recordatorio por ventana aunque dos workers lo
-- intenten (el que pierde el arriendo y el que retoma el trabajo).
--
-- La clave estable es `referenceId` = id del outbound_message del
-- recordatorio, que ya es único por (cita, antelación, hora de inicio) vía
-- appointment_reminders: reprogramar la cita cambia la hora de inicio, así
-- que es otra ventana y otro outbound, y no choca. Otras plantillas no entran
-- en el índice.
--
-- Aditiva. Antes del índice se resuelven los duplicados que el fallo haya
-- dejado: de cada grupo (clínica, referenceId) se conserva la fila más
-- antigua tal cual y a las demás se les quita SOLO el `referenceId` (no se
-- borra ninguna fila: el registro de envíos se conserva y el despachador no
-- las trata distinto). Se recorre por clínica porque email_outbox tiene RLS.
SET lock_timeout = '5s';

DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    UPDATE public."email_outbox" e
       SET "referenceId" = NULL
      FROM (
        SELECT "id",
               row_number() OVER (
                 PARTITION BY "referenceId" ORDER BY "createdAt", "id"
               ) AS n
          FROM public."email_outbox"
         WHERE "tenantId" = t
           AND "template" = 'appointment-reminder'
           AND "referenceId" IS NOT NULL
      ) d
     WHERE e."id" = d."id" AND d.n > 1;
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
END
$$;

CREATE UNIQUE INDEX "email_outbox_reminder_reference_key"
  ON "email_outbox" ("tenantId", "referenceId")
  WHERE "template" = 'appointment-reminder' AND "referenceId" IS NOT NULL;
