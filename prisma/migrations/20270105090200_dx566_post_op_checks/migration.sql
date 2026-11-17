-- DX-566: control postoperatorio. Al marcar hecho un procedimiento del
-- catálogo que lo pide, se crea la llamada de control al paciente para el
-- n-ésimo día hábil de la sede; la clínica la trabaja desde la lista del día
-- y el desenlace queda en la historia clínica (adenda o evolución nueva).
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   dental_catalog_items."requiresPostOpCheck"   boolean NOT NULL DEFAULT
--                        false: el procedimiento pide control.
--   dental_catalog_items."postOpCheckAfterDays"  smallint NOT NULL DEFAULT 1:
--                        días hábiles tras el procedimiento (1–30). CHECK:
--                        rango y solo en PROCEDURE. Expand puro: NOT NULL con
--                        DEFAULT constante solo toca el catálogo en PG 16; el
--                        CHECK se valida en la misma sentencia (todas las
--                        filas = false/1; la tabla es pequeña y no es
--                        caliente). Una réplica anterior que inserta sin
--                        nombrar las columnas recibe «sin control».
--   clinical_entry_addenda_tenant_patient_id_key  UNIQUE ("tenantId",
--                        "patientId", "id"): destino de la FK compuesta del
--                        control a su adenda (tabla no caliente, append-only).
--   post_op_checks       el control. FK COMPUESTAS por clínica a sede,
--                        paciente, ítem del plan y cita (los dos del MISMO
--                        paciente), procedimiento del catálogo, evolución y
--                        adenda (del MISMO paciente); FK a users del
--                        profesional y de quien lo cierra. Uno PENDING por
--                        ítem (único parcial: dos DONE no duplican). Estado y
--                        columnas del cierre coherentes por CHECK. Guarda: la
--                        identidad no cambia (salvo el paciente en la
--                        fusión), mientras está PENDING solo cambian la
--                        fecha, la sede y el profesional, se cierra una vez
--                        (PENDING → DONE | UNREACHABLE | CANCELLED, con la
--                        hora del servidor) y cerrado es inmutable. Sin
--                        DELETE para la app. Abre la puerta de la fusión
--                        (DX-266).
--   post_op_check_attempts  intentos de llamada. Append-only (sin UPDATE ni
--                        DELETE para la app); solo sobre un control PENDING;
--                        la hora la pone el servidor.
--   dx_patient_merge_tables()  la de DX-017 (20261230170200) +
--                        post_op_checks.patientId (lista cerrada de DX-266).
--
-- FK sobre tablas con RLS FORCE (DX-134): las de las tablas nuevas van DENTRO
-- de los CREATE TABLE (nacen vacías: la validación no lee filas). FK directa
-- a tenants con RESTRICT. RLS ENABLE + FORCE con la política NULLIF (DX-251).
-- Funciones con search_path fijo y pg_temp al final (SEC-032). Grants: ALTER
-- DEFAULT PRIVILEGES ya cubre a dentalix_app; aquí se le quita lo que no usa.
--
-- Vuelta atrás: desplegar la API anterior, recrear dx_patient_merge_tables con
-- la definición de 20261230170200 y
--   DROP TABLE public."post_op_check_attempts"; DROP TABLE public."post_op_checks";
--   DROP FUNCTION public.dx_post_op_checks_before_insert();
--   DROP FUNCTION public.dx_post_op_checks_guard();
--   DROP FUNCTION public.dx_post_op_check_attempts_before_insert();
--   DROP FUNCTION public.dx_post_op_check_attempts_immutable();
--   DROP TYPE "PostOpCheckStatus"; DROP TYPE "PostOpCheckOutcome";
--   DROP TYPE "PostOpAttemptOutcome"; DROP TYPE "PostOpCheckCancelReason";
--   DROP INDEX public."clinical_entry_addenda_tenant_patient_id_key";
--   ALTER TABLE public."dental_catalog_items"
--     DROP CONSTRAINT "dental_catalog_items_post_op_check",
--     DROP COLUMN "postOpCheckAfterDays", DROP COLUMN "requiresPostOpCheck";

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Catálogo: el procedimiento pide control
-- ---------------------------------------------------------------------------

ALTER TABLE "dental_catalog_items"
  ADD COLUMN "requiresPostOpCheck" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "postOpCheckAfterDays" SMALLINT NOT NULL DEFAULT 1,
  ADD CONSTRAINT "dental_catalog_items_post_op_check" CHECK (
    "postOpCheckAfterDays" BETWEEN 1 AND 30
    AND (NOT "requiresPostOpCheck" OR "kind" = 'PROCEDURE')
  );

-- Destino de la FK compuesta del control a su adenda (misma clínica y
-- paciente; la fusión mueve las dos en la misma sentencia).
CREATE UNIQUE INDEX "clinical_entry_addenda_tenant_patient_id_key"
  ON "clinical_entry_addenda"("tenantId", "patientId", "id");

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------

CREATE TYPE "PostOpCheckStatus" AS ENUM ('PENDING', 'DONE', 'UNREACHABLE', 'CANCELLED');
CREATE TYPE "PostOpCheckOutcome" AS ENUM ('FINE', 'DISCOMFORT', 'NEEDS_APPOINTMENT');
CREATE TYPE "PostOpAttemptOutcome" AS ENUM ('FINE', 'DISCOMFORT', 'NEEDS_APPOINTMENT', 'NO_ANSWER');
CREATE TYPE "PostOpCheckCancelReason" AS ENUM ('PROCEDURE_REVERTED', 'ITEM_DELETED');

-- ---------------------------------------------------------------------------
-- post_op_checks
-- ---------------------------------------------------------------------------

CREATE TABLE "post_op_checks" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "planItemId" UUID NOT NULL,
    "appointmentId" UUID,
    "locationId" UUID NOT NULL,
    "professionalId" UUID NOT NULL,
    "catalogItemId" UUID NOT NULL,
    "procedureName" TEXT NOT NULL,
    "dueOn" DATE NOT NULL,
    "status" "PostOpCheckStatus" NOT NULL DEFAULT 'PENDING',
    "outcome" "PostOpCheckOutcome",
    "closedAt" TIMESTAMP(3),
    "closedById" UUID,
    "cancelledReason" "PostOpCheckCancelReason",
    "clinicalEntryId" UUID,
    "addendumId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_op_checks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "post_op_checks_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "post_op_checks_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El ítem del plan y la cita, de la MISMA clínica Y del MISMO paciente
    -- (SEC-004). Con "appointmentId" NULL la FK no se comprueba.
    CONSTRAINT "post_op_checks_plan_item_fkey"
      FOREIGN KEY ("tenantId", "patientId", "planItemId")
      REFERENCES "treatment_plan_items"("tenantId", "patientId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "post_op_checks_appointment_fkey"
      FOREIGN KEY ("tenantId", "patientId", "appointmentId")
      REFERENCES "appointments"("tenantId", "patientId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "post_op_checks_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "post_op_checks_catalog_item_fkey"
      FOREIGN KEY ("tenantId", "catalogItemId")
      REFERENCES "dental_catalog_items"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Dónde quedó el desenlace: evolución y adenda del MISMO paciente.
    CONSTRAINT "post_op_checks_clinical_entry_fkey"
      FOREIGN KEY ("tenantId", "patientId", "clinicalEntryId")
      REFERENCES "clinical_entries"("tenantId", "patientId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "post_op_checks_addendum_fkey"
      FOREIGN KEY ("tenantId", "patientId", "addendumId")
      REFERENCES "clinical_entry_addenda"("tenantId", "patientId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "post_op_checks_professional_fkey"
      FOREIGN KEY ("professionalId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "post_op_checks_closed_by_fkey"
      FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "post_op_checks_values_check" CHECK (
      char_length(btrim("procedureName")) BETWEEN 1 AND 200
    ),
    -- Cada estado con sus columnas del cierre, y solo con ellas:
    --   PENDING      nada del cierre;
    --   DONE         desenlace, cierre (quién y cuándo) y la evolución;
    --   UNREACHABLE  cierre y la evolución, sin desenlace;
    --   CANCELLED    cierre y motivo, sin desenlace ni historia.
    -- Una adenda siempre con su evolución.
    CONSTRAINT "post_op_checks_state_check" CHECK (
      ("addendumId" IS NULL OR "clinicalEntryId" IS NOT NULL)
      AND CASE "status"
        WHEN 'PENDING' THEN "outcome" IS NULL AND "closedAt" IS NULL
          AND "closedById" IS NULL AND "cancelledReason" IS NULL
          AND "clinicalEntryId" IS NULL
        WHEN 'DONE' THEN "outcome" IS NOT NULL AND "closedAt" IS NOT NULL
          AND "closedById" IS NOT NULL AND "cancelledReason" IS NULL
          AND "clinicalEntryId" IS NOT NULL
        WHEN 'UNREACHABLE' THEN "outcome" IS NULL AND "closedAt" IS NOT NULL
          AND "closedById" IS NOT NULL AND "cancelledReason" IS NULL
          AND "clinicalEntryId" IS NOT NULL
        ELSE "outcome" IS NULL AND "closedAt" IS NOT NULL
          AND "closedById" IS NOT NULL AND "cancelledReason" IS NOT NULL
          AND "clinicalEntryId" IS NULL
      END
    )
);

-- Destino de la FK compuesta de los intentos (SEC-004).
CREATE UNIQUE INDEX "post_op_checks_tenant_id_key" ON "post_op_checks"("tenantId", "id");
-- Un control PENDING por ítem: dos DONE (o dos peticiones a la vez) no
-- duplican (INSERT … ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX "post_op_checks_pending_item_key"
  ON "post_op_checks"("tenantId", "planItemId") WHERE "status" = 'PENDING';
-- La lista del día y el contador de «Mi día»: pendientes de la sede por fecha.
CREATE INDEX "post_op_checks_pending_idx"
  ON "post_op_checks"("tenantId", "locationId", "dueOn") WHERE "status" = 'PENDING';
-- Controles del paciente (y lado hijo de la FK al paciente).
CREATE INDEX "post_op_checks_patient_idx"
  ON "post_op_checks"("tenantId", "patientId", "createdAt" DESC);
-- Lados hijos de las demás FK.
CREATE INDEX "post_op_checks_plan_item_idx"
  ON "post_op_checks"("tenantId", "patientId", "planItemId");
CREATE INDEX "post_op_checks_appointment_idx"
  ON "post_op_checks"("tenantId", "patientId", "appointmentId") WHERE "appointmentId" IS NOT NULL;
CREATE INDEX "post_op_checks_location_due_idx"
  ON "post_op_checks"("tenantId", "locationId", "dueOn");
CREATE INDEX "post_op_checks_catalog_item_idx"
  ON "post_op_checks"("tenantId", "catalogItemId");
CREATE INDEX "post_op_checks_clinical_entry_idx"
  ON "post_op_checks"("tenantId", "patientId", "clinicalEntryId") WHERE "clinicalEntryId" IS NOT NULL;
CREATE INDEX "post_op_checks_addendum_idx"
  ON "post_op_checks"("tenantId", "patientId", "addendumId") WHERE "addendumId" IS NOT NULL;
CREATE INDEX "post_op_checks_professional_idx" ON "post_op_checks"("professionalId");
CREATE INDEX "post_op_checks_closed_by_idx"
  ON "post_op_checks"("closedById") WHERE "closedById" IS NOT NULL;

-- Al insertar: nace PENDING y el procedimiento es el del ítem.
CREATE FUNCTION public.dx_post_op_checks_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'post_op_checks: un control nace pendiente (DX-566)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."treatment_plan_items" i
     WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."planItemId"
       AND i."catalogItemId" = NEW."catalogItemId"
  ) THEN
    RAISE EXCEPTION 'post_op_checks: el procedimiento no es el del ítem del plan (DX-566)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "post_op_checks_before_insert"
  BEFORE INSERT ON "post_op_checks"
  FOR EACH ROW EXECUTE FUNCTION public.dx_post_op_checks_before_insert();

-- Guarda. «Se cierra una vez»:
--   · DELETE/TRUNCATE solo un superusuario (purga y limpieza de test);
--   · un control cerrado (DONE, UNREACHABLE o CANCELLED) ya no cambia;
--   · mientras está PENDING solo cambian la fecha, la sede y el profesional
--     (la corrección del ítem hecho); cualquier columna nueva queda protegida
--     sola;
--   · al cerrarse solo cambian el estado y las columnas del cierre, y la hora
--     del cierre la pone el servidor.
CREATE FUNCTION public.dx_post_op_checks_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  pending_mutable text[] := ARRAY['dueOn', 'locationId', 'professionalId', 'updatedAt'];
  closing_mutable text[] := ARRAY['status', 'outcome', 'closedAt', 'closedById',
    'cancelledReason', 'clinicalEntryId', 'addendumId', 'updatedAt'];
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'post_op_checks: un control postoperatorio no se borra, se anula (DX-566)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'post_op_checks: un control cerrado no se modifica (DX-566)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'PENDING' THEN
    IF (pg_catalog.to_jsonb(NEW) - pending_mutable) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - pending_mutable) THEN
      RAISE EXCEPTION 'post_op_checks: de un control pendiente solo cambian la fecha, la sede y el profesional (DX-566)'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - closing_mutable) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - closing_mutable) THEN
    RAISE EXCEPTION 'post_op_checks: al cerrar un control solo cambian el estado y su cierre (DX-566)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  NEW."closedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "post_op_checks_guard"
  BEFORE UPDATE OR DELETE ON "post_op_checks"
  FOR EACH ROW EXECUTE FUNCTION public.dx_post_op_checks_guard();
CREATE TRIGGER "post_op_checks_no_truncate"
  BEFORE TRUNCATE ON "post_op_checks"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_post_op_checks_guard();

ALTER TABLE "post_op_checks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "post_op_checks"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "post_op_checks" FORCE ROW LEVEL SECURITY;

-- La app lee, crea, recalcula y cierra (también bloquea con FOR UPDATE);
-- nunca borra.
REVOKE DELETE, TRUNCATE ON "post_op_checks" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- post_op_check_attempts
-- ---------------------------------------------------------------------------

CREATE TABLE "post_op_check_attempts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "checkId" UUID NOT NULL,
    "outcome" "PostOpAttemptOutcome" NOT NULL,
    "note" TEXT,
    "byId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_op_check_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "post_op_check_attempts_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "post_op_check_attempts_check_fkey"
      FOREIGN KEY ("tenantId", "checkId") REFERENCES "post_op_checks"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "post_op_check_attempts_by_fkey"
      FOREIGN KEY ("byId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El mismo tope que la API (400 en español antes).
    CONSTRAINT "post_op_check_attempts_note_check" CHECK (
      "note" IS NULL OR char_length(btrim("note")) BETWEEN 1 AND 1000
    )
);

-- Intentos del control en orden (y lado hijo de la FK al control).
CREATE INDEX "post_op_check_attempts_check_idx"
  ON "post_op_check_attempts"("tenantId", "checkId", "at");
CREATE INDEX "post_op_check_attempts_by_idx" ON "post_op_check_attempts"("byId");

-- Al insertar: solo sobre un control PENDING; la hora la pone el servidor.
CREATE FUNCTION public.dx_post_op_check_attempts_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."post_op_checks" c
     WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."checkId"
       AND c."status" = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'post_op_check_attempts: el control ya está cerrado (DX-566)'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."at" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "post_op_check_attempts_before_insert"
  BEFORE INSERT ON "post_op_check_attempts"
  FOR EACH ROW EXECUTE FUNCTION public.dx_post_op_check_attempts_before_insert();

-- Append-only: ni UPDATE ni DELETE (salvo un superusuario: purga y limpieza
-- de test). Sin paciente propio: la fusión no los toca.
CREATE FUNCTION public.dx_post_op_check_attempts_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'post_op_check_attempts: un intento registrado no se modifica ni se borra (DX-566)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "post_op_check_attempts_immutable"
  BEFORE UPDATE OR DELETE ON "post_op_check_attempts"
  FOR EACH ROW EXECUTE FUNCTION public.dx_post_op_check_attempts_immutable();
CREATE TRIGGER "post_op_check_attempts_no_truncate"
  BEFORE TRUNCATE ON "post_op_check_attempts"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_post_op_check_attempts_immutable();

ALTER TABLE "post_op_check_attempts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "post_op_check_attempts"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "post_op_check_attempts" FORCE ROW LEVEL SECURITY;

-- La app solo inserta y lee.
REVOKE UPDATE, DELETE, TRUNCATE ON "post_op_check_attempts" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- Fusión de pacientes (DX-266): la lista de 20261230170200 (DX-017) +
-- post_op_checks
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
