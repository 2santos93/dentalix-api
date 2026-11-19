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
--                    fila. Lo existente se rellena en 20270122140100.
--   recall_contacts  "callbackOn": el día de «Llamar luego» (solo con
--                    CALL_BACK, CHECK NOT VALID). Índice ÚNICO parcial
--                    ("tenantId", "recallId", "appointmentId") WHERE BOOKED:
--                    el servidor (al crear la cita) y la web no dejan dos
--                    «Agendó» de la misma cita en el mismo recall. Antes de
--                    crearlo, la migración comprueba que no haya duplicados
--                    (un reintento de la web tras un corte) y, si los hay,
--                    se detiene con un mensaje claro y la consulta para
--                    localizarlos: recall_contacts es append-only, así que se
--                    resuelven con el superusuario y criterio clínico antes de
--                    repetir el despliegue (no se borran solos). Conviene
--                    correr esa consulta antes de desplegar.
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
--   dx_recall_phone_review_reset()  AFTER UPDATE de patients cuando la marca
--                    pasa de puesta a NULL (teléfono corregido o «Ya está
--                    corregido»): los recalls del paciente en su ciclo vuelven
--                    a 0 intentos y, si el último fue «Número equivocado», sin
--                    su ocultación (revisión DX-465, ruling 10).
--   dx_recall_next_due_after(dueAt, meses, día)  el primer vencimiento de la
--                    serie dueAt + k·meses (k ≥ 1) posterior a ese día: el
--                    fin del ciclo de intentos y el regreso de un «Rechaza»
--                    (ruling 2). IMMUTABLE; la usa la lista y el relleno.
--
-- Sin evento de auditoría sin usuario: el cierre del ciclo al agendar sin
-- usuario (reserva online, oferta de hueco) no escribe contacto ni evento, así
-- que audit_events_actor_check no cambia. Sin tablas nuevas con "patientId":
-- dx_patient_merge_tables() no cambia (las columnas nuevas viajan con su fila).
--
-- El índice de la lista con las columnas nuevas va en 20270122140200
-- (CONCURRENTLY, solo) y el viejo se suelta en 20270122140300; los VALIDATE en
-- 20270122140400. Funciones con search_path fijo y pg_temp al final (SEC-032).
--
-- Vuelta atrás: desplegar la API anterior, recrear dx_phone_e164_stale con la
-- definición de 20261226140000, recrear patient_recalls_tenant_due_visit_idx
-- (20261212090600) y
--   DROP INDEX public."patient_recalls_tenant_due_attempts_idx";
--   DROP INDEX public."recall_contacts_booked_appointment_key";
--   DROP TRIGGER patients_phone_review_reset ON public."patients";
--   DROP FUNCTION public.dx_recall_phone_review_reset();
--   DROP FUNCTION public.dx_recall_next_due_after(date, integer, date);
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

DO $$
DECLARE
  dup integer;
BEGIN
  SELECT count(*) INTO dup FROM (
    SELECT 1 FROM public."recall_contacts"
     WHERE "outcome" = 'BOOKED'
     GROUP BY "tenantId", "recallId", "appointmentId"
    HAVING count(*) > 1
  ) d;
  IF dup > 0 THEN
    RAISE EXCEPTION 'DX-465: hay % «Agendó» repetidos (misma cita en el mismo recall); recall_contacts es append-only y no se borran solos. Localízalos con: SELECT "tenantId", "recallId", "appointmentId", count(*) FROM recall_contacts WHERE "outcome" = ''BOOKED'' GROUP BY 1, 2, 3 HAVING count(*) > 1; resuélvelos con el superusuario y vuelve a desplegar.', dup;
  END IF;
END
$$;

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

-- ---------------------------------------------------------------------------
-- Fin del ciclo y regreso de un «Rechaza» (ruling 2)
-- ---------------------------------------------------------------------------

-- El primer vencimiento de la serie p_due + k·p_months (k ≥ 1) estrictamente
-- posterior a p_after, con el recorte a fin de mes de make_interval (el
-- mismo que addCivilMonths/nextDueAfter en la app).
CREATE OR REPLACE FUNCTION public.dx_recall_next_due_after(p_due date, p_months integer, p_after date)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT CASE
           WHEN k.k0 >= 1 AND (p_due + make_interval(months => p_months * k.k0))::date > p_after
             THEN (p_due + make_interval(months => p_months * k.k0))::date
           ELSE (p_due + make_interval(months => p_months * (k.k0 + 1)))::date
         END
    FROM (
      SELECT greatest(0, floor(
               ((extract(year FROM p_after) - extract(year FROM p_due)) * 12
                 + (extract(month FROM p_after) - extract(month FROM p_due))) / p_months
             ))::integer AS k0
    ) k
$function$;

-- ---------------------------------------------------------------------------
-- Teléfono corregido: los intentos del número equivocado no cuentan (ruling 10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dx_recall_phone_review_reset()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- Mismo orden de candados que la app: el paciente (ya bloqueado por este
  -- UPDATE) y después sus recalls.
  UPDATE public."patient_recalls" pr SET
    "attemptCount" = 0,
    "lastAttemptAt" = CASE
      WHEN EXISTS (
        SELECT 1 FROM public."recall_contacts" x
         WHERE x."tenantId" = pr."tenantId" AND x."recallId" = pr."id"
           AND x."createdAt" = pr."lastAttemptAt"
           AND x."outcome" = 'WRONG_NUMBER'
      ) THEN NULL
      ELSE pr."lastAttemptAt"
    END
   WHERE pr."tenantId" = NEW."tenantId"
     AND pr."patientId" = NEW."id"
     AND pr."cycleDueAt" = pr."dueAt"
     AND (pr."attemptCount" > 0 OR pr."lastAttemptAt" IS NOT NULL);
  RETURN NULL;
END;
$function$;

CREATE TRIGGER patients_phone_review_reset
  AFTER UPDATE ON "patients"
  FOR EACH ROW
  WHEN (OLD."phoneReviewFlaggedAt" IS NOT NULL AND NEW."phoneReviewFlaggedAt" IS NULL)
  EXECUTE FUNCTION public.dx_recall_phone_review_reset();
