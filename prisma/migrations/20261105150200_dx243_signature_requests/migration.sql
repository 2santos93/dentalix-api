-- DX-243: firma a distancia de consentimientos por enlace con código de
-- verificación.
--
-- Cambios:
--   SignatureRequestType / SignatureRequestChannel   enums nuevos (CONSENT y
--                     BUDGET; EMAIL). BUDGET queda reservado para DX-415: la
--                     API lo rechaza hoy, pero no hará falta migrar el enum.
--   signature_requests   cada enlace enviado: el documento congelado (título,
--                     texto ya resuelto, versión de la plantilla, profesional
--                     y firmante), el destino (y su forma enmascarada), el
--                     HASH del token y el HMAC del código (nunca en claro),
--                     intentos, bloqueo, caducidad, sesión del navegador que
--                     verificó (hash) y las horas de apertura, verificación,
--                     firma y anulación.
--   patient_consents   la firma del paciente a distancia se guarda aquí, con
--                     sus evidencias congeladas (canal, destino enmascarado,
--                     envío, apertura y verificación) y `signatureRequestId`.
--                     `professionalSignature` admite NULL SOLO en esas filas
--                     (CHECK): el profesional firma después.
--   patient_consent_countersignatures   la firma del profesional que completa
--                     un consentimiento firmado a distancia: append-only e
--                     inmutable, una por consentimiento y solo para uno que no
--                     la tenga (trigger).
--   audit_events_actor_check   admite actor NULL en los eventos del enlace que
--                     hace el propio paciente (abrir, pedir el código,
--                     verificarlo, bloquearlo y firmar), con origen LINK.
--
-- Reglas en la BD (la API responde antes en español; esto es la red):
--   - FK COMPUESTAS por tenant (SEC-004) dentro del CREATE TABLE (nacen
--     vacías; DX-134): paciente, sede, plantilla, plan (del MISMO paciente) y,
--     en patient_consents y la firma del profesional, la solicitud y el
--     consentimiento del MISMO paciente;
--   - CHECK de forma (hashes SHA-256 en hex, intentos 0..5, envíos del código
--     0..5) y de coherencia por estado (bloqueado ⇔ 5 fallos; verificado ⇒
--     abierto; firmado ⇒ verificado y ni anulado ni bloqueado);
--   - una solicitud firmada o anulada no cambia más, y su documento, su
--     destino y su token nunca cambian (trigger);
--   - sin borrado duro: DELETE y TRUNCATE solo un superusuario (purga), con
--     dx_forbid_clinical_record_mutation (DX-038).
--
-- Compatible hacia atrás: solo AÑADE (dos enums, dos tablas vacías, columnas
-- NULL, índices, triggers, RLS) y relaja dos restricciones: NOT NULL de
-- `professionalSignature` (las filas existentes siguen cumpliendo el CHECK
-- nuevo, que lo exige fuera de la firma a distancia) y el CHECK de actor
-- (más permisivo). El código anterior no escribe filas a distancia; si leyera
-- una, solo vería `professionalSignature` NULL.
--
-- Bloqueo: los ALTER sobre patient_consents (columnas NULL sin DEFAULT, DROP
-- NOT NULL, índices únicos) y el DROP/ADD CONSTRAINT de audit_events toman
-- ACCESS EXCLUSIVE/SHARE hasta el COMMIT sin reescribir las tablas; los
-- VALIDATE las recorren sin bloquear escrituras más de lo necesario.
-- lock_timeout evita quedar encolado detrás de una transacción larga.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "SignatureRequestType" AS ENUM ('CONSENT', 'BUDGET');
CREATE TYPE "SignatureRequestChannel" AS ENUM ('EMAIL');

-- ---------------------------------------------------------------------------
-- 1. Solicitudes de firma a distancia.
-- ---------------------------------------------------------------------------
CREATE TABLE "signature_requests" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "type" "SignatureRequestType" NOT NULL,
    "channel" "SignatureRequestChannel" NOT NULL,
    "templateId" UUID,
    "templateVersion" INTEGER,
    "treatmentPlanId" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "professionalUserId" UUID NOT NULL,
    "professionalName" TEXT NOT NULL,
    "signerType" "ConsentSignerType" NOT NULL,
    "signerName" TEXT NOT NULL,
    "signerDocument" TEXT,
    "destination" TEXT NOT NULL,
    "destinationMasked" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "codeHash" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "codeSentAt" TIMESTAMP(3),
    "codeSendCount" INTEGER NOT NULL DEFAULT 0,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "sessionHash" TEXT,
    "sessionExpiresAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "openedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "signature_requests_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTAS: paciente, sede, plantilla y plan (del MISMO paciente) de
    -- la MISMA clínica.
    CONSTRAINT "signature_requests_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "signature_requests_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "signature_requests_template_fkey"
      FOREIGN KEY ("tenantId", "templateId") REFERENCES "consent_templates"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "signature_requests_plan_fkey"
      FOREIGN KEY ("tenantId", "treatmentPlanId", "patientId")
      REFERENCES "treatment_plans"("tenantId", "id", "patientId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "signature_requests_professional_fkey"
      FOREIGN KEY ("professionalUserId") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "signature_requests_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "signature_requests_revoked_by_fkey"
      FOREIGN KEY ("revokedById") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Forma: hashes SHA-256 / HMAC-SHA256 en hex; nunca el token ni el código.
    CONSTRAINT "signature_requests_hash_check" CHECK (
      "tokenHash" ~ '^[0-9a-f]{64}$'
      AND ("codeHash" IS NULL OR "codeHash" ~ '^[0-9a-f]{64}$')
      AND ("sessionHash" IS NULL OR "sessionHash" ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT "signature_requests_text_check" CHECK (
      char_length(btrim("title")) BETWEEN 1 AND 200
      AND char_length(btrim("body")) > 0
      AND char_length(btrim("signerName")) BETWEEN 1 AND 200
      AND char_length(btrim("professionalName")) BETWEEN 1 AND 200
      AND char_length("destination") BETWEEN 3 AND 320
      AND char_length("destinationMasked") BETWEEN 1 AND 320
    ),
    -- Un consentimiento lleva su plantilla y la versión del texto congelado.
    CONSTRAINT "signature_requests_consent_check" CHECK (
      "type" <> 'CONSENT'
      OR ("templateId" IS NOT NULL AND "templateVersion" >= 1)
    ),
    -- Coherencia por estado.
    CONSTRAINT "signature_requests_state_check" CHECK (
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
      AND (("revokedAt" IS NULL) = ("revokedById" IS NULL))
      AND "expiresAt" > "createdAt"
    )
);

-- Búsqueda del enlace público por hash del token.
CREATE UNIQUE INDEX "signature_requests_tokenHash_key"
  ON "signature_requests"("tokenHash");
-- Destino de las FK compuestas de patient_consents (SEC-004).
CREATE UNIQUE INDEX "signature_requests_tenant_id_patient_key"
  ON "signature_requests"("tenantId", "id", "patientId");
-- Solicitudes del paciente en su ficha (más recientes primero); lado hijo de
-- la FK al paciente.
CREATE INDEX "signature_requests_patient_idx"
  ON "signature_requests"("tenantId", "patientId", "createdAt" DESC);
-- Lados hijos de las FK a sede, plantilla, plan y usuarios.
CREATE INDEX "signature_requests_location_idx"
  ON "signature_requests"("tenantId", "locationId");
CREATE INDEX "signature_requests_template_idx"
  ON "signature_requests"("tenantId", "templateId");
CREATE INDEX "signature_requests_plan_idx"
  ON "signature_requests"("tenantId", "treatmentPlanId");
CREATE INDEX "signature_requests_professional_idx"
  ON "signature_requests"("professionalUserId");
CREATE INDEX "signature_requests_created_by_idx"
  ON "signature_requests"("createdById");
CREATE INDEX "signature_requests_revoked_by_idx"
  ON "signature_requests"("revokedById");

-- Ciclo de vida: una solicitud firmada o anulada no cambia más; el documento,
-- el firmante, el destino, el token, la caducidad y la autoría nunca cambian.
-- search_path fijo con pg_temp al final (SEC-032).
CREATE FUNCTION public."signature_requests_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
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
     -- Las horas de la evidencia, una vez puestas, no se reescriben.
     OR (OLD."openedAt" IS NOT NULL AND NEW."openedAt" IS DISTINCT FROM OLD."openedAt")
     OR (OLD."verifiedAt" IS NOT NULL AND NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt")
     OR (OLD."lockedAt" IS NOT NULL AND NEW."lockedAt" IS DISTINCT FROM OLD."lockedAt") THEN
    RAISE EXCEPTION 'signature_requests: una solicitud firmada o anulada no cambia, ni su documento, destino o token (DX-243)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "signature_requests_guard"
  BEFORE UPDATE ON "signature_requests"
  FOR EACH ROW EXECUTE FUNCTION public."signature_requests_guard"();
CREATE TRIGGER "signature_requests_no_delete"
  BEFORE DELETE ON "signature_requests"
  FOR EACH ROW EXECUTE FUNCTION public."dx_forbid_clinical_record_mutation"();
CREATE TRIGGER "signature_requests_no_truncate"
  BEFORE TRUNCATE ON "signature_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION public."dx_forbid_clinical_record_mutation"();

-- RLS por tenant. NULLIF (DX-251): sin tenant en la sesión, la GUC vacía es
-- NULL y no se ve ninguna fila (en vez de un error de cast). El FORCE va al
-- final de la sección 2, después de la FK de patient_consents (DX-134).
ALTER TABLE "signature_requests" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "signature_requests"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- 2. patient_consents: la firma del paciente a distancia y sus evidencias.
-- ---------------------------------------------------------------------------
ALTER TABLE "patient_consents"
  ADD COLUMN "signatureRequestId" UUID,
  ADD COLUMN "remoteChannel" "SignatureRequestChannel",
  ADD COLUMN "remoteDestinationMasked" TEXT,
  ADD COLUMN "remoteSentAt" TIMESTAMP(3),
  ADD COLUMN "remoteOpenedAt" TIMESTAMP(3),
  ADD COLUMN "remoteVerifiedAt" TIMESTAMP(3),
  ALTER COLUMN "professionalSignature" DROP NOT NULL;

-- Destino de la FK compuesta de la firma del profesional, y una solicitud
-- produce como mucho un consentimiento.
CREATE UNIQUE INDEX "patient_consents_tenant_id_patient_key"
  ON "patient_consents"("tenantId", "id", "patientId");
CREATE UNIQUE INDEX "patient_consents_signature_request_key"
  ON "patient_consents"("tenantId", "signatureRequestId", "patientId");

-- DX-134: con FORCE, el owner validaría la FK con la RLS (sin tenant no ve
-- filas). NO FORCE en la hija mientras se valida (todas sus filas tienen
-- `signatureRequestId` NULL) y FORCE de vuelta en las dos tablas al acabar.
ALTER TABLE "patient_consents" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_consents" ADD CONSTRAINT "patient_consents_signature_request_fkey"
  FOREIGN KEY ("tenantId", "signatureRequestId", "patientId")
  REFERENCES "signature_requests"("tenantId", "id", "patientId")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "patient_consents" VALIDATE CONSTRAINT "patient_consents_signature_request_fkey";

-- En pantalla: firma del profesional y ninguna evidencia remota. A distancia:
-- todas las evidencias y SIN firma del profesional (va en
-- patient_consent_countersignatures).
ALTER TABLE "patient_consents" ADD CONSTRAINT "patient_consents_remote_check" CHECK (
  ("signatureRequestId" IS NULL
    AND "professionalSignature" IS NOT NULL
    AND "remoteChannel" IS NULL
    AND "remoteDestinationMasked" IS NULL
    AND "remoteSentAt" IS NULL
    AND "remoteOpenedAt" IS NULL
    AND "remoteVerifiedAt" IS NULL)
  OR ("signatureRequestId" IS NOT NULL
    AND "professionalSignature" IS NULL
    AND "remoteChannel" IS NOT NULL
    AND char_length("remoteDestinationMasked") BETWEEN 1 AND 320
    AND "remoteSentAt" IS NOT NULL
    AND "remoteOpenedAt" IS NOT NULL
    AND "remoteVerifiedAt" IS NOT NULL)
) NOT VALID;
ALTER TABLE "patient_consents" VALIDATE CONSTRAINT "patient_consents_remote_check";

ALTER TABLE "patient_consents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "signature_requests" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. Firma del profesional de un consentimiento firmado a distancia.
-- ---------------------------------------------------------------------------
CREATE TABLE "patient_consent_countersignatures" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "consentId" UUID NOT NULL,
    "professionalUserId" UUID NOT NULL,
    "professionalName" TEXT NOT NULL,
    "professionalSignature" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_consent_countersignatures_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_consent_countersignatures_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_consent_countersignatures_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El consentimiento, de la MISMA clínica y del MISMO paciente.
    CONSTRAINT "patient_consent_countersignatures_consent_fkey"
      FOREIGN KEY ("tenantId", "consentId", "patientId")
      REFERENCES "patient_consents"("tenantId", "id", "patientId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_consent_countersignatures_professional_fkey"
      FOREIGN KEY ("professionalUserId") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_consent_countersignatures_hash_check"
      CHECK ("contentHash" ~ '^[0-9a-f]{64}$'),
    -- Mismo tope que las firmas de patient_consents (200 KB decodificados).
    CONSTRAINT "patient_consent_countersignatures_signature_check"
      CHECK (length("professionalSignature") BETWEEN 1 AND 273068),
    CONSTRAINT "patient_consent_countersignatures_name_check"
      CHECK (char_length(btrim("professionalName")) BETWEEN 1 AND 200)
);

-- Una por consentimiento; lado hijo de la FK al consentimiento.
CREATE UNIQUE INDEX "patient_consent_countersignatures_consent_key"
  ON "patient_consent_countersignatures"("tenantId", "consentId", "patientId");
CREATE INDEX "patient_consent_countersignatures_patient_idx"
  ON "patient_consent_countersignatures"("tenantId", "patientId");
CREATE INDEX "patient_consent_countersignatures_professional_idx"
  ON "patient_consent_countersignatures"("professionalUserId");

-- Solo completa un consentimiento firmado a distancia que aún no tiene la
-- firma del profesional (los firmados en pantalla ya la llevan).
CREATE FUNCTION public."patient_consent_countersignatures_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."patient_consents" c
    WHERE c."tenantId" = NEW."tenantId"
      AND c."id" = NEW."consentId"
      AND c."signatureRequestId" IS NOT NULL
      AND c."professionalSignature" IS NULL
  ) THEN
    RAISE EXCEPTION 'patient_consent_countersignatures: solo se añade a un consentimiento firmado a distancia (DX-243)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patient_consent_countersignatures_guard"
  BEFORE INSERT ON "patient_consent_countersignatures"
  FOR EACH ROW EXECUTE FUNCTION public."patient_consent_countersignatures_guard"();
-- Inmutable como el consentimiento: ni UPDATE ni DELETE (salvo la purga de un
-- superusuario).
CREATE TRIGGER "patient_consent_countersignatures_immutable"
  BEFORE UPDATE OR DELETE ON "patient_consent_countersignatures"
  FOR EACH ROW EXECUTE FUNCTION public."dx_forbid_clinical_record_mutation"();
CREATE TRIGGER "patient_consent_countersignatures_no_truncate"
  BEFORE TRUNCATE ON "patient_consent_countersignatures"
  FOR EACH STATEMENT EXECUTE FUNCTION public."dx_forbid_clinical_record_mutation"();

ALTER TABLE "patient_consent_countersignatures" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_consent_countersignatures"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "patient_consent_countersignatures" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 4. audit_events: los pasos del enlace los hace el paciente (sin usuario ni
--    rol). Solo esos eventos concretos, con origen LINK, se suman a los que
--    ya podían ir sin actor (20261104130000_dx402_audit_backup_rate_actor).
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
    -- DX-402: el barrido congeló una tasa de respaldo en un abono.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'PAYMENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' = 'EXCHANGE_RATE_BACKUP') IS TRUE
    -- DX-243: el paciente abre el enlace de firma, pide el código, lo
    -- verifica (o lo bloquea al fallar 5 veces) y firma.
    OR ("resourceType" = 'SIGNATURE_REQUEST'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'LINK'
        AND (("action" = 'VIEW' AND "metadata" ->> 'reason' = 'SIGNATURE_LINK_OPENED')
          OR ("action" = 'SEND' AND "metadata" ->> 'reason' = 'SIGNATURE_CODE_SENT')
          OR ("action" = 'UPDATE' AND "metadata" ->> 'reason' IN ('SIGNATURE_CODE_VERIFIED', 'SIGNATURE_LINK_LOCKED'))
          OR ("action" = 'SIGN' AND "metadata" ->> 'reason' = 'SIGNATURE_PATIENT_SIGNED'))) IS TRUE
  ) NOT VALID;
ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";
