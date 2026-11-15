-- DX-306: certificados del paciente. Dos tipos de documento, con un solo
-- formato para todas las clínicas (nada depende del país):
--   ATTENDANCE  justificante de asistencia: «asistió a consulta» con las horas
--               reales de llegada y salida de la cita (o las programadas,
--               marcadas así). Sin ningún dato clínico.
--   REST        certificado de reposo: días (1..máximo de la clínica) desde
--               una fecha no anterior a la atención, con diagnóstico solo si
--               la clínica lo imprime.
--
-- Cambios:
--   patient_certificates  un documento por fila. FK compuestas por clínica a
--                     paciente, cita (del MISMO paciente), sede y membresía del
--                     profesional (SEC-004). Foto inalterable (`snapshot`) de
--                     paciente, profesional, sede y clínica al emitir. Número
--                     correlativo por sede que pone el trigger (candado
--                     consultivo de la sede: dos emisiones a la vez nunca
--                     repiten número). Solo se anula una vez (motivo, autor,
--                     fecha) y se enlaza el PDF archivado; nada más cambia y no
--                     se borra (trigger + sin DELETE para la app). RLS FORCE.
--   patient_certificates_live_key  índice único PARCIAL: un certificado vivo
--                     (sin anular) de cada tipo por cita.
--   appointments."completedAt"  hora en que la cita pasó a COMPLETED (la
--                     salida del paciente, DX-200). La pone el trigger
--                     appointments_completed_at; al salir de COMPLETED vuelve a
--                     NULL. La app no la escribe. Las citas anteriores quedan
--                     con NULL: su justificante va con las horas programadas.
--   tenants."certificateRestMaxDays"  máximo de días de reposo (1..365, 30 de
--                     plataforma). CHECK NOT VALID; VALIDATE en 20261223090300.
--   tenants."certificateRestPrintDiagnosis"  si el reposo lleva diagnóstico.
--                     false de plataforma.
--
-- Compatible hacia atrás: tabla nueva, columnas con DEFAULT constante (sin
-- reescritura) o NULL que el código anterior no lee, y un trigger que solo
-- escribe la columna nueva. lock_timeout evita quedar encolado tras una
-- transacción larga.

SET LOCAL lock_timeout = '5s';

-- Ajustes de la clínica ------------------------------------------------------

ALTER TABLE "tenants"
  ADD COLUMN "certificateRestMaxDays" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "certificateRestPrintDiagnosis" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_certificate_rest_max_days_check"
  CHECK ("certificateRestMaxDays" BETWEEN 1 AND 365) NOT VALID;

-- Hora de salida de la cita --------------------------------------------------

ALTER TABLE "appointments" ADD COLUMN "completedAt" TIMESTAMP(3);

-- La pone la BD: entrar en COMPLETED la fija (hora del servidor), quedarse la
-- conserva y salir la borra. Ni la app ni nadie la fija a mano.
CREATE FUNCTION public."appointments_completed_at"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Una cita que nace atendida (importaciones, pruebas) no tiene salida.
    NEW."completedAt" := NULL;
    RETURN NEW;
  END IF;
  IF NEW."status" = 'COMPLETED' THEN
    IF OLD."status" IS DISTINCT FROM 'COMPLETED' THEN
      NEW."completedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    ELSE
      NEW."completedAt" := OLD."completedAt";
    END IF;
  ELSE
    NEW."completedAt" := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "appointments_completed_at"
  BEFORE INSERT OR UPDATE ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION public."appointments_completed_at"();

-- Certificados ---------------------------------------------------------------

CREATE TYPE "PatientCertificateKind" AS ENUM ('ATTENDANCE', 'REST');

CREATE TABLE "patient_certificates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "professionalMembershipId" UUID NOT NULL,
    "issuedById" UUID NOT NULL,
    "kind" "PatientCertificateKind" NOT NULL,
    "number" INTEGER NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attendedFrom" TIMESTAMP(3) NOT NULL,
    "attendedUntil" TIMESTAMP(3) NOT NULL,
    "timesSource" TEXT NOT NULL,
    "restDays" INTEGER,
    "restStartDate" DATE,
    "restEndDate" DATE,
    "diagnosis" TEXT,
    "snapshot" JSONB NOT NULL,
    "documentId" UUID,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "voidedDocumentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_certificates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_certificates_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_certificates_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId")
      REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- La cita es del MISMO paciente y de la MISMA clínica.
    CONSTRAINT "patient_certificates_appointment_fkey"
      FOREIGN KEY ("tenantId", "patientId", "appointmentId")
      REFERENCES "appointments"("tenantId", "patientId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_certificates_location_fkey"
      FOREIGN KEY ("tenantId", "locationId")
      REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_certificates_membership_fkey"
      FOREIGN KEY ("tenantId", "professionalMembershipId")
      REFERENCES "clinic_memberships"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_certificates_issued_by_fkey"
      FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_certificates_voided_by_fkey"
      FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_certificates_document_fkey"
      FOREIGN KEY ("tenantId", "documentId")
      REFERENCES "patient_documents"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_certificates_voided_document_fkey"
      FOREIGN KEY ("tenantId", "voidedDocumentId")
      REFERENCES "patient_documents"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_certificates_number_check" CHECK ("number" > 0),
    CONSTRAINT "patient_certificates_times_check"
      CHECK ("timesSource" IN ('ACTUAL', 'SCHEDULED')
             AND "attendedUntil" >= "attendedFrom"),
    -- El justificante no lleva nada del reposo ni diagnóstico; el reposo
    -- lleva días, inicio y fin coherentes.
    CONSTRAINT "patient_certificates_kind_check"
      CHECK (
        ("kind" = 'ATTENDANCE'
          AND "restDays" IS NULL AND "restStartDate" IS NULL
          AND "restEndDate" IS NULL AND "diagnosis" IS NULL)
        OR ("kind" = 'REST'
          AND "restDays" BETWEEN 1 AND 365
          AND "restStartDate" IS NOT NULL
          AND "restEndDate" = "restStartDate" + ("restDays" - 1))
      ),
    CONSTRAINT "patient_certificates_diagnosis_check"
      CHECK ("diagnosis" IS NULL OR char_length(btrim("diagnosis")) BETWEEN 1 AND 500),
    CONSTRAINT "patient_certificates_snapshot_check"
      CHECK (jsonb_typeof("snapshot") = 'object'),
    -- Anulación: las tres juntas o ninguna; el PDF anulado, solo anulado.
    CONSTRAINT "patient_certificates_void_check"
      CHECK (
        (("voidedAt" IS NULL) = ("voidedById" IS NULL))
        AND (("voidedAt" IS NULL) = ("voidReason" IS NULL))
        AND ("voidReason" IS NULL OR char_length(btrim("voidReason")) BETWEEN 3 AND 500)
        AND ("voidedDocumentId" IS NULL OR "voidedAt" IS NOT NULL)
      )
);

-- El número es único por sede (red bajo el candado del trigger).
CREATE UNIQUE INDEX "patient_certificates_location_number_key"
  ON "patient_certificates"("tenantId", "locationId", "number");
-- Un certificado vivo de cada tipo por cita.
CREATE UNIQUE INDEX "patient_certificates_live_key"
  ON "patient_certificates"("tenantId", "appointmentId", "kind")
  WHERE "voidedAt" IS NULL;
-- Lista de la ficha, más reciente primero (y lado hijo de la FK al paciente).
CREATE INDEX "patient_certificates_patient_idx"
  ON "patient_certificates"("tenantId", "patientId", "issuedAt" DESC);
-- Lados hijos de las demás FK.
CREATE INDEX "patient_certificates_appointment_idx"
  ON "patient_certificates"("tenantId", "patientId", "appointmentId");
CREATE INDEX "patient_certificates_membership_idx"
  ON "patient_certificates"("tenantId", "professionalMembershipId");
CREATE INDEX "patient_certificates_issued_by_idx"
  ON "patient_certificates"("issuedById");
CREATE INDEX "patient_certificates_voided_by_idx"
  ON "patient_certificates"("voidedById");
CREATE INDEX "patient_certificates_document_idx"
  ON "patient_certificates"("tenantId", "documentId");
CREATE INDEX "patient_certificates_voided_document_idx"
  ON "patient_certificates"("tenantId", "voidedDocumentId");

-- Al insertar: número correlativo de la sede, hora del servidor, nunca nace
-- anulado ni con PDF, y la cita es de la sede del certificado.
CREATE FUNCTION public."patient_certificates_before_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  appointment_location UUID;
BEGIN
  SELECT a."locationId" INTO appointment_location
    FROM public."appointments" a
   WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."appointmentId";
  IF appointment_location IS DISTINCT FROM NEW."locationId" THEN
    RAISE EXCEPTION 'patient_certificates: la sede no es la de la cita (DX-306)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."voidedAt" IS NOT NULL OR NEW."voidedById" IS NOT NULL
     OR NEW."voidReason" IS NOT NULL OR NEW."voidedDocumentId" IS NOT NULL
     OR NEW."documentId" IS NOT NULL THEN
    RAISE EXCEPTION 'patient_certificates: nace sin anular y sin PDF (DX-306)'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Candado consultivo de la sede hasta el final de la transacción: la
  -- siguiente emisión de la misma sede espera y ve este número (READ
  -- COMMITTED: cada sentencia, foto nueva).
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'patient_certificates:' || NEW."tenantId"::text || ':' || NEW."locationId"::text, 0));
  SELECT COALESCE(max(c."number"), 0) + 1 INTO NEW."number"
    FROM public."patient_certificates" c
   WHERE c."tenantId" = NEW."tenantId" AND c."locationId" = NEW."locationId";
  NEW."issuedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  NEW."createdAt" := NEW."issuedAt";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patient_certificates_before_insert"
  BEFORE INSERT ON "patient_certificates"
  FOR EACH ROW EXECUTE FUNCTION public."patient_certificates_before_insert"();

-- Inmutable: solo se enlaza su PDF una vez y se anula una vez (y se enlaza el
-- PDF anulado una vez). No se borra.
CREATE FUNCTION public."patient_certificates_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'patient_certificates: un certificado no se borra, se anula (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."appointmentId" IS DISTINCT FROM OLD."appointmentId"
     OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
     OR NEW."professionalMembershipId" IS DISTINCT FROM OLD."professionalMembershipId"
     OR NEW."issuedById" IS DISTINCT FROM OLD."issuedById"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."number" IS DISTINCT FROM OLD."number"
     OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
     OR NEW."attendedFrom" IS DISTINCT FROM OLD."attendedFrom"
     OR NEW."attendedUntil" IS DISTINCT FROM OLD."attendedUntil"
     OR NEW."timesSource" IS DISTINCT FROM OLD."timesSource"
     OR NEW."restDays" IS DISTINCT FROM OLD."restDays"
     OR NEW."restStartDate" IS DISTINCT FROM OLD."restStartDate"
     OR NEW."restEndDate" IS DISTINCT FROM OLD."restEndDate"
     OR NEW."diagnosis" IS DISTINCT FROM OLD."diagnosis"
     OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'patient_certificates: el contenido de un certificado emitido no cambia (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."documentId" IS NOT NULL
     AND NEW."documentId" IS DISTINCT FROM OLD."documentId" THEN
    RAISE EXCEPTION 'patient_certificates: el PDF archivado no cambia (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."voidedAt" IS NOT NULL AND (
       NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt"
       OR NEW."voidedById" IS DISTINCT FROM OLD."voidedById"
       OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason") THEN
    RAISE EXCEPTION 'patient_certificates: un certificado anulado no cambia (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."voidedDocumentId" IS NOT NULL
     AND NEW."voidedDocumentId" IS DISTINCT FROM OLD."voidedDocumentId" THEN
    RAISE EXCEPTION 'patient_certificates: el PDF anulado no cambia (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patient_certificates_guard"
  BEFORE UPDATE OR DELETE ON "patient_certificates"
  FOR EACH ROW EXECUTE FUNCTION public."patient_certificates_guard"();
CREATE TRIGGER "patient_certificates_no_truncate"
  BEFORE TRUNCATE ON "patient_certificates"
  FOR EACH STATEMENT EXECUTE FUNCTION public."patient_certificates_guard"();

ALTER TABLE "patient_certificates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_certificates"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "patient_certificates" FORCE ROW LEVEL SECURITY;

REVOKE DELETE, TRUNCATE ON "patient_certificates" FROM dentalix_app;
GRANT SELECT, INSERT, UPDATE ON "patient_certificates" TO dentalix_app;
