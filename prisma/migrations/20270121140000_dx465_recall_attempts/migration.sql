-- DX-465: recall con intentos. `recall_contacts` (DX-015) ya es el intento
-- (canal, desenlace, nota, autor, hora del servidor, append-only); aquí entra
-- el ESTADO del ciclo, los ajustes por sede, la fecha de «Llamar luego», el
-- teléfono por revisar y un solo «Agendó» por recall y cita.
--
-- Cambios, todos ADITIVOS (el código anterior no lee ni escribe nada nuevo):
--   patient_recalls  "attemptCount" (≥ 0, CHECK NOT VALID), "lastAttemptAt",
--                    "callbackOn", "skipUntil" y "cycleDueAt": el estado del
--                    ciclo, que escribe la app en la transacción del contacto
--                    con la fila bloqueada. Vale mientras "cycleDueAt" =
--                    "dueAt"; si el vencimiento cambia (se hizo el control o
--                    se fijó otra fecha) el ciclo empieza de cero sin tocar la
--                    fila. Lo existente se rellena en 20270121140100.
--   recall_contacts  "callbackOn": el día de «Llamar luego» (solo con
--                    CALL_BACK, CHECK NOT VALID). Índice ÚNICO parcial
--                    ("tenantId", "recallId", "appointmentId") WHERE BOOKED:
--                    el servidor (al crear la cita) y la web no dejan dos
--                    «Agendó» de la misma cita en el mismo recall. Si una base
--                    tuviera ya dos (un reintento de la web tras un corte), el
--                    CREATE falla con la clave repetida: localizarlas con
--                      SELECT "tenantId", "recallId", "appointmentId", count(*)
--                        FROM recall_contacts WHERE "outcome" = 'BOOKED'
--                       GROUP BY 1, 2, 3 HAVING count(*) > 1;
--                    (append-only: se resuelve con el superusuario y criterio
--                    clínico antes de repetir el despliegue).
--   patients         "phoneReviewFlaggedAt" y "phoneReviewFlaggedById"
--                    (puntero suave, sin FK): «Número equivocado» marca el
--                    teléfono para revisar. Las dos o ninguna (CHECK NOT
--                    VALID). La anula dx_phone_e164_stale (abajo) si cambia
--                    "phone": el mismo sitio donde se invalida "phoneE164".
--   location_recall_settings  por sede (sin fila = 7 días y 3 intentos):
--                    días de ocultación tras un intento (1–90) y tope de
--                    intentos (1–10), quién los cambió. FK directa a tenants
--                    RESTRICT, compuesta a la sede, a users. RLS ENABLE +
--                    FORCE con la política NULLIF (DX-251). Sin DELETE para
--                    la app.
--   dx_phone_e164_stale()  la de DX-266 (20261226140000) + la marca de
--                    revisión, solo en patients (la función la comparten los
--                    responsables, que no la tienen).
--
-- Sin evento de auditoría sin usuario: el cierre del ciclo al agendar sin
-- usuario (reserva online, oferta de hueco) no escribe contacto ni evento, así
-- que audit_events_actor_check no cambia. Sin tablas nuevas con "patientId":
-- dx_patient_merge_tables() no cambia (las columnas nuevas viajan con su fila).
--
-- El índice de la lista con las columnas nuevas va en 20270121140200
-- (CONCURRENTLY, solo) y el viejo se suelta en 20270121140300; los VALIDATE en
-- 20270121140400. Funciones con search_path fijo y pg_temp al final (SEC-032).
--
-- Vuelta atrás: desplegar la API anterior, recrear dx_phone_e164_stale con la
-- definición de 20261226140000, recrear patient_recalls_tenant_due_visit_idx
-- (20261212090600) y
--   DROP INDEX public."patient_recalls_tenant_due_attempts_idx";
--   DROP INDEX public."recall_contacts_booked_appointment_key";
--   DROP TABLE public."location_recall_settings";
--   ALTER TABLE public."patient_recalls" DROP COLUMN "attemptCount",
--     DROP COLUMN "lastAttemptAt", DROP COLUMN "callbackOn",
--     DROP COLUMN "skipUntil", DROP COLUMN "cycleDueAt";
--   ALTER TABLE public."patients" DROP COLUMN "phoneReviewFlaggedAt",
--     DROP COLUMN "phoneReviewFlaggedById";
--   (recall_contacts."callbackOn" se queda: la tabla es append-only.)
-- lock_timeout evita quedar encolado tras una transacción larga.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- patient_recalls: estado del ciclo
-- ---------------------------------------------------------------------------

ALTER TABLE "patient_recalls"
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "callbackOn" DATE,
  ADD COLUMN "skipUntil" DATE,
  ADD COLUMN "cycleDueAt" DATE;

ALTER TABLE "patient_recalls"
  ADD CONSTRAINT "patient_recalls_attempt_count_check"
  CHECK ("attemptCount" >= 0) NOT VALID;

-- ---------------------------------------------------------------------------
-- recall_contacts: «Llamar luego» con fecha y un solo «Agendó» por cita
-- ---------------------------------------------------------------------------

ALTER TABLE "recall_contacts" ADD COLUMN "callbackOn" DATE;

ALTER TABLE "recall_contacts"
  ADD CONSTRAINT "recall_contacts_callback_check"
  CHECK ("callbackOn" IS NULL OR "outcome" = 'CALL_BACK') NOT VALID;

CREATE UNIQUE INDEX "recall_contacts_booked_appointment_key"
  ON "recall_contacts"("tenantId", "recallId", "appointmentId")
  WHERE "outcome" = 'BOOKED';

-- ---------------------------------------------------------------------------
-- patients: teléfono por revisar
-- ---------------------------------------------------------------------------

ALTER TABLE "patients"
  ADD COLUMN "phoneReviewFlaggedAt" TIMESTAMP(3),
  ADD COLUMN "phoneReviewFlaggedById" UUID;

ALTER TABLE "patients"
  ADD CONSTRAINT "patients_phone_review_check"
  CHECK (("phoneReviewFlaggedAt" IS NULL) = ("phoneReviewFlaggedById" IS NULL)) NOT VALID;

CREATE OR REPLACE FUNCTION public.dx_phone_e164_stale()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW."phone" IS DISTINCT FROM OLD."phone" THEN
    NEW."phoneE164" := NULL;
    NEW."phoneE164CheckedAt" := NULL;
    -- DX-465: un teléfono nuevo ya no es el «número equivocado». Solo en
    -- patients (los responsables no tienen la marca; plpgsql resuelve el
    -- campo al ejecutar la rama).
    IF TG_TABLE_NAME = 'patients' THEN
      NEW."phoneReviewFlaggedAt" := NULL;
      NEW."phoneReviewFlaggedById" := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- location_recall_settings
-- ---------------------------------------------------------------------------

CREATE TABLE "location_recall_settings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "hideDays" INTEGER NOT NULL DEFAULT 7,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_recall_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "location_recall_settings_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "location_recall_settings_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "location_recall_settings_updated_by_fkey"
      FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Los mismos límites que la API (400 en español antes).
    CONSTRAINT "location_recall_settings_hide_days_check" CHECK ("hideDays" BETWEEN 1 AND 90),
    CONSTRAINT "location_recall_settings_max_attempts_check" CHECK ("maxAttempts" BETWEEN 1 AND 10)
);

-- Una fila por sede (el PUT hace upsert) y lado hijo de la FK a la sede.
CREATE UNIQUE INDEX "location_recall_settings_tenant_location_key"
  ON "location_recall_settings"("tenantId", "locationId");
CREATE INDEX "location_recall_settings_updated_by_idx"
  ON "location_recall_settings"("updatedById") WHERE "updatedById" IS NOT NULL;

ALTER TABLE "location_recall_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "location_recall_settings"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "location_recall_settings" FORCE ROW LEVEL SECURITY;

-- La app lee y guarda (upsert); nunca borra: volver a 7/3 es guardarlos.
REVOKE DELETE, TRUNCATE ON "location_recall_settings" FROM dentalix_app;
