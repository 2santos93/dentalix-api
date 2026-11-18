-- DX-561: seguimiento automático de presupuestos presentados. Un barrido
-- horario manda al paciente (o al responsable de un menor), por sede y dentro
-- de su franja horaria, como mucho 3 avisos por presentación (grupo de
-- opciones A/B) con un enlace de aceptación nuevo por opción; se detiene al
-- aceptar, rechazar, agendar, vencer el presupuesto o pausarlo.
--
-- Cambios (todos ADITIVOS salvo el CHECK de estado de signature_requests, que
-- se recrea sin su cláusula de anulación y la pasa a un CHECK propio; el
-- código anterior no lee ni escribe nada nuevo):
--   location_quote_follow_up_settings  ajustes por sede (sin fila = apagado):
--                        activado, días de cada aviso (1–3 valores
--                        estrictamente crecientes de 1 a 90) y franja
--                        horaria local [desde, hasta). FK directa a tenants
--                        RESTRICT, FK compuesta a la sede, FK a users de quien
--                        lo cambió. Sin DELETE para la app.
--   quote_follow_up_messages  una fila por (presentación, paso): el aviso
--                        enviado (SENT, con sus solicitudes de firma, el email
--                        y el destinatario enmascarado) o el paso omitido
--                        (SKIPPED + motivo). UNIQUE ("tenantId", "groupId",
--                        "step"): dos workers no envían dos veces el mismo
--                        paso. FK COMPUESTA del grupo al plan raíz del MISMO
--                        paciente, a la sede y al paciente. Inmutable tras el
--                        alta (la fusión de pacientes solo reasigna el
--                        paciente), sin UPDATE ni DELETE para la app.
--   treatment_plans."quoteFollowUpPausedAt" / "quoteFollowUpPausedById"
--                        pausa del seguimiento (se escribe en todos los planes
--                        del grupo). Las dos o ninguna (CHECK NOT VALID); FK a
--                        users (columna recién nacida en NULL).
--   signature_requests."origin"  STAFF (la clínica, DX-243/DX-415) o
--                        FOLLOW_UP (el trabajo del seguimiento, sin usuario):
--                        "createdById" admite NULL solo en FOLLOW_UP, y
--                        FOLLOW_UP solo en presupuestos (CHECK NOT VALID).
--   signature_requests."revokedByFollowUp"  el trabajo del seguimiento anuló
--                        el enlace vivo del plan al enviar uno nuevo: sin
--                        usuario. La regla «anulado ⇔ quién lo anuló» pasa del
--                        CHECK de estado a uno propio (NOT VALID) con esta
--                        alternativa. La guarda congela además el origen.
--   email_outbox_quote_follow_up_reference_key  un solo email por aviso
--                        (referenceId), como el resumen semanal (DX-568).
--   dx_patient_merge_tables()  la de DX-566 (20270105090200) +
--                        quote_follow_up_messages.patientId (DX-266).
--
-- Los VALIDATE van en 20270107140300 (SHARE UPDATE EXCLUSIVE, sin bloquear
-- escrituras). FK sobre tablas con RLS FORCE (DX-134): las de las tablas nuevas
-- van DENTRO de los CREATE TABLE (nacen vacías); la de treatment_plans, con NO
-- FORCE antes y FORCE después (la columna nace en NULL). RLS ENABLE + FORCE
-- con la política NULLIF (DX-251). Funciones con search_path fijo y pg_temp al
-- final (SEC-032).
--
-- Vuelta atrás: desplegar la API anterior, recrear dx_patient_merge_tables con
-- la definición de 20270105090200, el guard de signature_requests con la de
-- 20261226140000 y su CHECK de estado original, y
--   DROP TABLE public."quote_follow_up_messages";
--   DROP TABLE public."location_quote_follow_up_settings";
--   DROP FUNCTION public.dx_quote_follow_up_messages_guard();
--   DROP INDEX public."email_outbox_quote_follow_up_reference_key";
--   ALTER TABLE public."treatment_plans" DROP COLUMN "quoteFollowUpPausedAt",
--     DROP COLUMN "quoteFollowUpPausedById";
--   (signature_requests conserva "origin" y "revokedByFollowUp" hasta que no
--   quede ninguna fila FOLLOW_UP: "createdById" no vuelve a NOT NULL con ellas.)
--   DROP TYPE "QuoteFollowUpStatus"; DROP TYPE "QuoteFollowUpReason";
-- lock_timeout evita quedar encolado tras una transacción larga.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------

CREATE TYPE "QuoteFollowUpStatus" AS ENUM ('SENT', 'SKIPPED');
CREATE TYPE "QuoteFollowUpReason" AS ENUM (
  'SUPERSEDED',
  'TOO_LATE',
  'STOPPED_ACCEPTED',
  'STOPPED_REJECTED',
  'STOPPED_SCHEDULED',
  'EXPIRED',
  'OPTED_OUT',
  'CHANNEL_NONE',
  'CHANNEL_WHATSAPP',
  'NO_EMAIL',
  'NO_CONSENT',
  'NO_LINK_HOST',
  'NO_PROFESSIONAL'
);
CREATE TYPE "SignatureRequestOrigin" AS ENUM ('STAFF', 'FOLLOW_UP');

-- ---------------------------------------------------------------------------
-- location_quote_follow_up_settings
-- ---------------------------------------------------------------------------

CREATE TABLE "location_quote_follow_up_settings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "offsetsDays" INTEGER[] NOT NULL,
    "sendFromHour" INTEGER NOT NULL,
    "sendUntilHour" INTEGER NOT NULL,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_quote_follow_up_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "location_quote_follow_up_settings_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "location_quote_follow_up_settings_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "location_quote_follow_up_settings_updated_by_fkey"
      FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Los mismos límites que la API (400 en español antes): de 1 a 3 avisos,
    -- días de 1 a 90 estrictamente crecientes, sin NULL; franja local
    -- [desde, hasta) con desde 0–23 y hasta 1–24 mayor que desde.
    CONSTRAINT "location_quote_follow_up_settings_offsets_check" CHECK (
      pg_catalog.array_ndims("offsetsDays") = 1
      AND pg_catalog.array_lower("offsetsDays", 1) = 1
      AND pg_catalog.cardinality("offsetsDays") BETWEEN 1 AND 3
      AND pg_catalog.array_position("offsetsDays", NULL) IS NULL
      AND "offsetsDays"[1] BETWEEN 1 AND 90
      AND (pg_catalog.cardinality("offsetsDays") < 2
        OR ("offsetsDays"[2] > "offsetsDays"[1] AND "offsetsDays"[2] <= 90))
      AND (pg_catalog.cardinality("offsetsDays") < 3
        OR ("offsetsDays"[3] > "offsetsDays"[2] AND "offsetsDays"[3] <= 90))
    ),
    CONSTRAINT "location_quote_follow_up_settings_window_check" CHECK (
      "sendFromHour" BETWEEN 0 AND 23
      AND "sendUntilHour" BETWEEN 1 AND 24
      AND "sendUntilHour" > "sendFromHour"
    )
);

-- Una fila por sede (el PUT hace upsert) y lado hijo de la FK a la sede.
CREATE UNIQUE INDEX "location_quote_follow_up_settings_tenant_location_key"
  ON "location_quote_follow_up_settings"("tenantId", "locationId");
CREATE INDEX "location_quote_follow_up_settings_updated_by_idx"
  ON "location_quote_follow_up_settings"("updatedById") WHERE "updatedById" IS NOT NULL;

ALTER TABLE "location_quote_follow_up_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "location_quote_follow_up_settings"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "location_quote_follow_up_settings" FORCE ROW LEVEL SECURITY;

-- La app lee y guarda (upsert); nunca borra: «apagado» es enabled = false.
REVOKE DELETE, TRUNCATE ON "location_quote_follow_up_settings" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- treatment_plans: pausa del seguimiento
-- ---------------------------------------------------------------------------

ALTER TABLE "treatment_plans"
  ADD COLUMN "quoteFollowUpPausedAt" TIMESTAMP(3),
  ADD COLUMN "quoteFollowUpPausedById" UUID;

-- FK bajo FORCE (DX-134): añadirla valida leyendo la hija con la RLS del
-- owner, así que se quita FORCE a treatment_plans y se devuelve justo después.
-- La columna acaba de nacer en NULL: la validación no encuentra nada que
-- comprobar. users no tiene RLS. ACCESS EXCLUSIVE hasta el COMMIT
-- (lock_timeout arriba).
ALTER TABLE "treatment_plans" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_quote_follow_up_paused_by_fkey"
  FOREIGN KEY ("quoteFollowUpPausedById") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treatment_plans" FORCE ROW LEVEL SECURITY;

ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_quote_follow_up_pause_check"
  CHECK (("quoteFollowUpPausedAt" IS NULL) = ("quoteFollowUpPausedById" IS NULL)) NOT VALID;

-- ---------------------------------------------------------------------------
-- signature_requests: origen y anulación por el seguimiento
-- ---------------------------------------------------------------------------

ALTER TABLE "signature_requests"
  ADD COLUMN "origin" "SignatureRequestOrigin" NOT NULL DEFAULT 'STAFF',
  ADD COLUMN "revokedByFollowUp" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "signature_requests" ALTER COLUMN "createdById" DROP NOT NULL;

-- Con usuario ⇔ de la clínica; el del seguimiento nunca lleva usuario y solo
-- envía presupuestos.
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_origin_check"
  CHECK (
    (("origin" = 'STAFF') = ("createdById" IS NOT NULL))
    AND ("origin" = 'STAFF' OR "type" = 'BUDGET')
  ) NOT VALID;

-- El CHECK de estado de 20261105150200, igual pero sin la cláusula
-- («anulado ⇔ revokedById»), que pasa a signature_requests_revoked_check.
ALTER TABLE "signature_requests" DROP CONSTRAINT "signature_requests_state_check";
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_state_check" CHECK (
  "failedAttempts" BETWEEN 0 AND 5
  AND "codeSendCount" BETWEEN 0 AND 5
  AND (("failedAttempts" >= 5) = ("lockedAt" IS NOT NULL))
  AND (("codeHash" IS NULL) = ("codeExpiresAt" IS NULL))
  AND (("sessionHash" IS NULL) = ("sessionExpiresAt" IS NULL))
  AND ("codeHash" IS NULL OR "codeSentAt" IS NOT NULL)
  AND ("codeSentAt" IS NULL OR "openedAt" IS NOT NULL)
  AND ("verifiedAt" IS NULL OR "openedAt" IS NOT NULL)
  AND ("sessionHash" IS NULL OR "verifiedAt" IS NOT NULL)
  AND ("signedAt" IS NULL
    OR ("verifiedAt" IS NOT NULL AND "revokedAt" IS NULL AND "lockedAt" IS NULL))
  AND "expiresAt" > "createdAt"
) NOT VALID;
-- Viva: ni quién la anuló ni la marca. Anulada: por una persona
-- ("revokedById") o por el seguimiento ("revokedByFollowUp"), una de las dos.
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_revoked_check" CHECK (
  CASE WHEN "revokedAt" IS NULL
    THEN "revokedById" IS NULL AND NOT "revokedByFollowUp"
    ELSE ("revokedById" IS NOT NULL) <> "revokedByFollowUp"
  END
) NOT VALID;

-- El guard de DX-243/DX-415 (con la puerta de la fusión de DX-266) con una
-- condición más: el origen es parte de la identidad del envío y nunca cambia.
CREATE OR REPLACE FUNCTION public.signature_requests_guard()
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
  IF OLD."signedAt" IS NOT NULL
     OR OLD."revokedAt" IS NOT NULL
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."channel" IS DISTINCT FROM OLD."channel"
     OR NEW."templateId" IS DISTINCT FROM OLD."templateId"
     OR NEW."templateVersion" IS DISTINCT FROM OLD."templateVersion"
     OR NEW."treatmentPlanId" IS DISTINCT FROM OLD."treatmentPlanId"
     OR NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."body" IS DISTINCT FROM OLD."body"
     OR NEW."professionalUserId" IS DISTINCT FROM OLD."professionalUserId"
     OR NEW."professionalName" IS DISTINCT FROM OLD."professionalName"
     OR NEW."signerType" IS DISTINCT FROM OLD."signerType"
     OR NEW."signerName" IS DISTINCT FROM OLD."signerName"
     OR NEW."signerDocument" IS DISTINCT FROM OLD."signerDocument"
     OR NEW."destination" IS DISTINCT FROM OLD."destination"
     OR NEW."destinationMasked" IS DISTINCT FROM OLD."destinationMasked"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."budgetContent" IS DISTINCT FROM OLD."budgetContent"
     OR NEW."budgetContentHash" IS DISTINCT FROM OLD."budgetContentHash"
     OR NEW."origin" IS DISTINCT FROM OLD."origin"
     -- Las horas de la evidencia, una vez puestas, no se reescriben.
     OR (OLD."openedAt" IS NOT NULL AND NEW."openedAt" IS DISTINCT FROM OLD."openedAt")
     OR (OLD."verifiedAt" IS NOT NULL AND NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt")
     OR (OLD."lockedAt" IS NOT NULL AND NEW."lockedAt" IS DISTINCT FROM OLD."lockedAt") THEN
    RAISE EXCEPTION 'signature_requests: una solicitud firmada o anulada no cambia, ni su documento, destino, token u origen (DX-243, DX-415, DX-561)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- quote_follow_up_messages
-- ---------------------------------------------------------------------------

CREATE TABLE "quote_follow_up_messages" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "step" SMALLINT NOT NULL,
    "status" "QuoteFollowUpStatus" NOT NULL,
    "reason" "QuoteFollowUpReason",
    "planIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "signatureRequestIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "recipientMasked" TEXT,
    "language" TEXT,
    "languageFallbackFrom" TEXT,
    "emailOutboxId" UUID,
    "sentAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_follow_up_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quote_follow_up_messages_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "quote_follow_up_messages_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El grupo es el plan raíz (coalesce("optionGroupId", "id")) del MISMO
    -- paciente (SEC-004); la fusión mueve los dos en la misma sentencia.
    CONSTRAINT "quote_follow_up_messages_group_fkey"
      FOREIGN KEY ("tenantId", "groupId", "patientId")
      REFERENCES "treatment_plans"("tenantId", "id", "patientId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "quote_follow_up_messages_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "quote_follow_up_messages_step_check" CHECK ("step" BETWEEN 1 AND 3),
    -- Enviado: sus solicitudes (1–3, una por opción), sus planes, el email, el
    -- destinatario enmascarado y el idioma, sin motivo. Omitido: su motivo y
    -- nada del envío.
    CONSTRAINT "quote_follow_up_messages_state_check" CHECK (
      CASE "status"
        WHEN 'SENT' THEN "reason" IS NULL
          AND "sentAt" IS NOT NULL
          AND "emailOutboxId" IS NOT NULL
          AND "recipientMasked" IS NOT NULL
          AND char_length("recipientMasked") BETWEEN 1 AND 320
          AND "language" IN ('es', 'en')
          AND ("languageFallbackFrom" IS NULL OR char_length("languageFallbackFrom") BETWEEN 2 AND 35)
          AND pg_catalog.cardinality("signatureRequestIds") BETWEEN 1 AND 3
          AND pg_catalog.cardinality("planIds") = pg_catalog.cardinality("signatureRequestIds")
        ELSE "reason" IS NOT NULL
          AND "sentAt" IS NULL
          AND "emailOutboxId" IS NULL
          AND "recipientMasked" IS NULL
          AND "language" IS NULL
          AND "languageFallbackFrom" IS NULL
          AND pg_catalog.cardinality("signatureRequestIds") = 0
          AND pg_catalog.cardinality("planIds") <= 3
      END
    )
);

-- Un registro por presentación y paso: el INSERT del trabajo lo usa como
-- segunda barrera (tras el candado del grupo) y la lista de «Presupuestos por
-- seguir» lee el último paso por grupo.
CREATE UNIQUE INDEX "quote_follow_up_messages_group_step_key"
  ON "quote_follow_up_messages"("tenantId", "groupId", "step");
-- El informe de efectividad: los envíos de una sede en un período.
CREATE INDEX "quote_follow_up_messages_location_idx"
  ON "quote_follow_up_messages"("tenantId", "locationId", "decidedAt");
-- Lados hijos de las FK al paciente y al grupo (con el paciente).
CREATE INDEX "quote_follow_up_messages_patient_idx"
  ON "quote_follow_up_messages"("tenantId", "patientId");
CREATE INDEX "quote_follow_up_messages_group_idx"
  ON "quote_follow_up_messages"("tenantId", "groupId", "patientId");

-- Guarda: un registro no cambia ni se borra (es el rastro de lo que se envió
-- o se omitió). DELETE/TRUNCATE solo un superusuario (purga y limpieza de
-- test); la fusión de pacientes solo reasigna el paciente.
CREATE FUNCTION public.dx_quote_follow_up_messages_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'quote_follow_up_messages: un aviso de seguimiento registrado no se modifica ni se borra (DX-561)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "quote_follow_up_messages_guard"
  BEFORE UPDATE OR DELETE ON "quote_follow_up_messages"
  FOR EACH ROW EXECUTE FUNCTION public.dx_quote_follow_up_messages_guard();
CREATE TRIGGER "quote_follow_up_messages_no_truncate"
  BEFORE TRUNCATE ON "quote_follow_up_messages"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_quote_follow_up_messages_guard();

ALTER TABLE "quote_follow_up_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "quote_follow_up_messages"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "quote_follow_up_messages" FORCE ROW LEVEL SECURITY;

-- La app solo inserta y lee (la fusión corre como SECURITY DEFINER).
REVOKE UPDATE, DELETE, TRUNCATE ON "quote_follow_up_messages" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- email_outbox: un email por aviso (DX-272)
-- ---------------------------------------------------------------------------
-- Sobre una tabla que solo tiene filas de otras plantillas: el predicado no
-- casa con ninguna y no hay duplicados que limpiar (molde de DX-568).
CREATE UNIQUE INDEX "email_outbox_quote_follow_up_reference_key"
  ON "email_outbox" ("tenantId", "referenceId")
  WHERE "template" = 'quote-follow-up' AND "referenceId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Fusión de pacientes (DX-266): la lista de 20270105090200 (DX-566) +
-- quote_follow_up_messages
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dx_patient_merge_tables()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT ARRAY[
    'anesthesia_administrations.patientId',
    'appointment_plan_items.patientId',
    'appointment_reserved_overrides.patientId',
    'appointment_status_reversals.patientId',
    'appointment_waitlist.patientId',
    'appointments.patientId',
    'cancellation_fees.patientId',
    'clinical_entries.patientId',
    'clinical_entry_addenda.patientId',
    'clinical_entry_diagnoses.patientId',
    'clinical_record_copies.patientId',
    'closing_queue_dismissals.patientId',
    'collection_notes.patientId',
    'data_processing_consents.patientId',
    'dental_lab_orders.patientId',
    'external_order_copy_links.patientId',
    'external_orders.patientId',
    'medical_history_reviews.patientId',
    'medical_history_submissions.patientId',
    'medical_history_versions.patientId',
    'opening_balances.patientId',
    'ortho_cases.patientId',
    'ortho_visits.patientId',
    'patient_agreements.patientId',
    'patient_certificate_copy_links.patientId',
    'patient_certificates.patientId',
    'patient_consent_countersignatures.patientId',
    'patient_consents.patientId',
    'patient_coverages.patientId',
    'patient_credit_entries.patientId',
    'patient_credit_refunds.patientId',
    'patient_credit_transfers.patientId',
    'patient_dentition_events.patientId',
    'patient_documents.patientId',
    'patient_implants.patientId',
    'patient_majority_reviews.patientId',
    'patient_recalls.patientId',
    'patient_responsible_parties.patientId',
    'patient_responsible_parties.responsiblePatientId',
    'patient_retention_actions.patientId',
    'payment_links.patientId',
    'payment_plans.patientId',
    'payment_promises.patientId',
    'payment_reports.patientId',
    'payments.patientId',
    'perio_exams.patientId',
    'post_op_checks.patientId',
    'post_op_instruction_deliveries.patientId',
    'prescription_copy_links.patientId',
    'prescriptions.patientId',
    'quote_follow_up_messages.patientId',
    'recall_contacts.patientId',
    'reminder_opt_out_links.patientId',
    'reminder_opt_out_match_warnings.patientId',
    'sedation_records.patientId',
    'signature_requests.patientId',
    'signed_consent_pdf_links.patientId',
    'signed_consent_pdfs.patientId',
    'tooth_records.patientId',
    'treatment_plan_acceptances.patientId',
    'treatment_plan_items.patientId',
    'treatment_plan_repricings.patientId',
    'treatment_plans.patientId',
    'waitlist_offers.patientId'
  ]::text[]
$$;
