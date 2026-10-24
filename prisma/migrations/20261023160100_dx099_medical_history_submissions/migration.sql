-- DX-099: anamnesis previa a la cita por enlace seguro, con revisión del
-- profesional.
--
-- Cambios:
--   medical_history_versions."source"   origen de la versión: STAFF (todas
--                     las existentes y lo que teclea el personal) o
--                     PATIENT_FORM (aceptada desde el formulario del
--                     paciente). DEFAULT constante: no reescribe la tabla
--                     (PG >= 11) ni dispara su trigger de inalterabilidad
--                     (DX-038), que es de UPDATE/DELETE por fila.
--   medical_history_submissions   cada enlace que se manda al paciente y lo
--                     que respondió: hash del token (nunca el token), caducidad,
--                     anulación, estado, respuestas (JSONB), quién lo revisó,
--                     cuándo, el motivo del rechazo y la versión que creó al
--                     aceptarlo. Sede de la bandeja (la de la cita, o la de
--                     quien lo creó).
--   data_processing_consents_evidence_check   una fila PATIENT_LINK (la
--                     autorización que da el propio paciente en el formulario)
--                     lleva versión de política pero no usuario que la
--                     registre: el titular no es un usuario de la clínica.
--   audit_events_actor_check   admite actor NULL también en el envío del
--                     formulario y en la autorización que lo acompaña, que
--                     hace el propio paciente por enlace.
--
-- Reglas en la BD (la API responde antes en español; esto es la red):
--   - FK COMPUESTAS por tenant (SEC-004), dentro del CREATE TABLE (nace
--     vacía; DX-134): paciente, cita (del MISMO paciente), sede y versión
--     resultante (de la MISMA clínica y del MISMO paciente,
--     mhv_tenant_patient_id_key);
--   - CHECK de coherencia por estado: respuestas y fecha de envío desde
--     SUBMITTED; revisor y fecha al aceptar o rechazar; versión resultante
--     solo y siempre en ACCEPTED; motivo solo y siempre en REJECTED;
--   - sin borrado duro: DELETE y TRUNCATE solo un superusuario (purga),
--     con dx_forbid_clinical_record_mutation (DX-038);
--   - un envío revisado (ACCEPTED, REJECTED) o caducado (EXPIRED) no cambia
--     más, y las respuestas guardadas no se reescriben (trigger).
--
-- Compatible hacia atrás: solo AÑADE (una columna con DEFAULT, una tabla
-- vacía, índices, triggers, RLS y dos CHECK MÁS PERMISIVOS que los
-- anteriores). El código anterior no las conoce.
--
-- Bloqueo: los DROP CONSTRAINT toman ACCESS EXCLUSIVE sobre
-- data_processing_consents y audit_events (y sus particiones) hasta el COMMIT;
-- los VALIDATE las recorren sin reescribirlas. lock_timeout evita quedar
-- encolado detrás de una transacción larga.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Origen de cada versión de la anamnesis.
-- ---------------------------------------------------------------------------
ALTER TABLE "medical_history_versions"
  ADD COLUMN "source" "MedicalHistorySource" NOT NULL DEFAULT 'STAFF';

-- ---------------------------------------------------------------------------
-- 2. Envíos del formulario.
-- ---------------------------------------------------------------------------
CREATE TABLE "medical_history_submissions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "appointmentId" UUID,
    "locationId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "status" "MedicalHistorySubmissionStatus" NOT NULL DEFAULT 'PENDING_PATIENT',
    "questionnaireVersion" TEXT NOT NULL,
    "answers" JSONB,
    "submittedAt" TIMESTAMP(3),
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "resultingVersionId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medical_history_submissions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "medical_history_submissions_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTAS: paciente, cita (del MISMO paciente), sede y versión
    -- resultante (del MISMO paciente) de la MISMA clínica.
    CONSTRAINT "medical_history_submissions_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "medical_history_submissions_appointment_fkey"
      FOREIGN KEY ("tenantId", "patientId", "appointmentId")
      REFERENCES "appointments"("tenantId", "patientId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "medical_history_submissions_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "medical_history_submissions_version_fkey"
      FOREIGN KEY ("tenantId", "patientId", "resultingVersionId")
      REFERENCES "medical_history_versions"("tenantId", "patientId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "medical_history_submissions_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "medical_history_submissions_reviewed_by_fkey"
      FOREIGN KEY ("reviewedById") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- SHA-256 en hex del token; las respuestas, como mucho 64 KB.
    CONSTRAINT "medical_history_submissions_token_check"
      CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "medical_history_submissions_answers_size_check"
      CHECK ("answers" IS NULL OR octet_length("answers"::text) <= 65536),
    CONSTRAINT "medical_history_submissions_questionnaire_check"
      CHECK (char_length("questionnaireVersion") BETWEEN 1 AND 40),
    -- Coherencia por estado.
    CONSTRAINT "medical_history_submissions_state_check" CHECK (
      (("status" IN ('SUBMITTED', 'ACCEPTED', 'REJECTED'))
        = ("answers" IS NOT NULL AND "submittedAt" IS NOT NULL))
      AND (("status" IN ('ACCEPTED', 'REJECTED'))
        = ("reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL))
      AND (("status" = 'ACCEPTED') = ("resultingVersionId" IS NOT NULL))
      AND (("status" = 'REJECTED') = ("rejectReason" IS NOT NULL))
      AND ("rejectReason" IS NULL
        OR char_length(btrim("rejectReason")) BETWEEN 3 AND 500)
      AND ("revokedAt" IS NULL OR "status" = 'EXPIRED')
    )
);

-- Búsqueda del enlace público por hash del token.
CREATE UNIQUE INDEX "medical_history_submissions_tokenHash_key"
  ON "medical_history_submissions"("tokenHash");
-- Bandeja «Anamnesis por revisar» (estado, sede, más antiguas primero) y su
-- contador del menú; también el lado hijo de la FK a la sede.
CREATE INDEX "medical_history_submissions_inbox_idx"
  ON "medical_history_submissions"("tenantId", "status", "locationId", "submittedAt");
-- Envíos del paciente en su ficha (más recientes primero); lado hijo de la FK
-- al paciente.
CREATE INDEX "medical_history_submissions_patient_idx"
  ON "medical_history_submissions"("tenantId", "patientId", "createdAt" DESC);
-- Lados hijos de las FK a la cita y a la versión resultante.
CREATE INDEX "medical_history_submissions_appointment_idx"
  ON "medical_history_submissions"("tenantId", "appointmentId")
  WHERE "appointmentId" IS NOT NULL;
CREATE INDEX "medical_history_submissions_version_idx"
  ON "medical_history_submissions"("tenantId", "resultingVersionId")
  WHERE "resultingVersionId" IS NOT NULL;
CREATE INDEX "medical_history_submissions_created_by_idx"
  ON "medical_history_submissions"("createdById");
CREATE INDEX "medical_history_submissions_reviewed_by_idx"
  ON "medical_history_submissions"("reviewedById")
  WHERE "reviewedById" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Ciclo de vida en la BD. Un envío revisado o caducado no cambia más; las
--    respuestas, una vez guardadas, no se reescriben; la identidad del
--    envío (clínica, paciente, cita, sede, token, quién lo creó y cuándo)
--    nunca cambia. search_path fijo con pg_temp al final (SEC-032).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public."medical_history_submissions_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD."status" IN ('ACCEPTED', 'REJECTED', 'EXPIRED')
     OR (OLD."answers" IS NOT NULL
         AND NEW."answers" IS DISTINCT FROM OLD."answers")
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."appointmentId" IS DISTINCT FROM OLD."appointmentId"
     OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."questionnaireVersion" IS DISTINCT FROM OLD."questionnaireVersion"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'medical_history_submissions: un envío revisado o caducado no cambia, y sus respuestas no se reescriben (DX-099)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "medical_history_submissions_guard"
  BEFORE UPDATE ON "medical_history_submissions"
  FOR EACH ROW EXECUTE FUNCTION public."medical_history_submissions_guard"();
CREATE TRIGGER "medical_history_submissions_no_delete"
  BEFORE DELETE ON "medical_history_submissions"
  FOR EACH ROW EXECUTE FUNCTION public."dx_forbid_clinical_record_mutation"();
CREATE TRIGGER "medical_history_submissions_no_truncate"
  BEFORE TRUNCATE ON "medical_history_submissions"
  FOR EACH STATEMENT EXECUTE FUNCTION public."dx_forbid_clinical_record_mutation"();

-- ---------------------------------------------------------------------------
-- 4. RLS forzada por tenant. NULLIF (DX-251): sin tenant en la sesión, la GUC
--    vacía es NULL y no se ve ninguna fila (en vez de un error de cast).
-- ---------------------------------------------------------------------------
ALTER TABLE "medical_history_submissions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "medical_history_submissions"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "medical_history_submissions" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 5. Autorización dada por el propio paciente en el formulario: versión de
--    política obligatoria, sin usuario que la registre.
-- ---------------------------------------------------------------------------
ALTER TABLE "data_processing_consents"
  DROP CONSTRAINT "data_processing_consents_evidence_check";
ALTER TABLE "data_processing_consents"
  ADD CONSTRAINT "data_processing_consents_evidence_check" CHECK (
    "channel" = 'LEGACY'
    OR ("policyVersionId" IS NOT NULL
        AND ("recordedById" IS NOT NULL OR "channel" = 'PATIENT_LINK'))
  ) NOT VALID;
ALTER TABLE "data_processing_consents"
  VALIDATE CONSTRAINT "data_processing_consents_evidence_check";

-- ---------------------------------------------------------------------------
-- 6. audit_events: el envío del formulario y la autorización que lo acompaña
--    los hace el paciente (sin usuario ni rol). Solo esas dos escrituras
--    concretas, con origen LINK, se suman a las que ya podían ir sin actor.
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actor_check";
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_check"
  CHECK (
    "actorUserId" IS NOT NULL
    OR "action" = 'LOGIN_FAILED'
    -- IS TRUE: un CHECK que da NULL PASA.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'PATIENT'
        AND "actorRole" IS NULL
        AND "resourceId" = "patientId"
        AND "metadata" ->> 'reason' = 'REMINDER_OPT_OUT'
        AND "metadata" ->> 'origin' IN ('LINK', 'MESSAGE')) IS TRUE
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'PAYMENT_PROMISE'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' IN ('PROMISE_KEPT', 'PROMISE_BROKEN')) IS TRUE
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'MEDICAL_HISTORY_SUBMISSION'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'LINK'
        AND "metadata" ->> 'reason' = 'ANAMNESIS_SUBMITTED') IS TRUE
    OR ("action" = 'CREATE'
        AND "resourceType" = 'DATA_CONSENT'
        AND "actorRole" IS NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'LINK'
        AND "metadata" ->> 'reason' = 'ANAMNESIS_LINK') IS TRUE
  ) NOT VALID;
ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";

-- ---------------------------------------------------------------------------
-- 7. DX-102: índice parcial de audit_events por el valor nuevo del recurso.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "audit_events_resource_medical_history_submission_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'MEDICAL_HISTORY_SUBMISSION';
