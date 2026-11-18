-- DX-101: enlace de acceso del paciente (estado de cuenta por enlace seguro).
-- El personal comparte con el paciente (o su responsable) un enlace de SOLO
-- LECTURA a sus citas, presupuestos y estado de cuenta; para abrirlo hace
-- falta además la fecha de nacimiento (segundo factor).
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   "PatientAccessScope"   enum APPOINTMENTS | PLANS | ACCOUNT.
--   patient_access_links   el enlace. Solo el SHA-256 del token (UNIQUE), los
--                          apartados compartidos (1..3, sin repetir), la
--                          caducidad, la revocación (una sola vez, con quién),
--                          el contador de fallos (0..5), el bloqueo de 30 min
--                          y el último acceso verificado. FK directa a
--                          tenants (RESTRICT), FK COMPUESTA al paciente de la
--                          MISMA clínica y FK a users de quien lo crea y de
--                          quien lo revoca. Guarda: la identidad no cambia
--                          (salvo el paciente en la fusión), uno revocado es
--                          inmutable y solo cambian contador, bloqueo, último
--                          acceso y revocación. Sin DELETE para la app.
--   dx_patient_merge_tables()  la de DX-561 (20270107140100) +
--                          patient_access_links.patientId (lista cerrada de
--                          DX-266).
--
-- FK sobre tablas con RLS FORCE (DX-134): van DENTRO del CREATE TABLE (nace
-- vacía: la validación no lee filas). RLS ENABLE + FORCE con la política
-- NULLIF (DX-251). Funciones con search_path fijo y pg_temp al final
-- (SEC-032). Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app; aquí se
-- le quita lo que no usa.
--
-- Vuelta atrás: desplegar la API anterior, recrear dx_patient_merge_tables con
-- la definición de 20270107140100 y
--   DROP TABLE public."patient_access_links";
--   DROP FUNCTION public.dx_patient_access_links_before_insert();
--   DROP FUNCTION public.dx_patient_access_links_guard();
--   DROP TYPE "PatientAccessScope";

SET LOCAL lock_timeout = '5s';

CREATE TYPE "PatientAccessScope" AS ENUM ('APPOINTMENTS', 'PLANS', 'ACCOUNT');

CREATE TABLE "patient_access_links" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" "PatientAccessScope"[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastViewedAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_access_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_access_links_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_access_links_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_access_links_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_access_links_revoked_by_fkey"
      FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- SHA-256 en hex: nunca el token en claro.
    CONSTRAINT "patient_access_links_token_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    -- 1..3 apartados (sin repetir: lo comprueba el trigger de alta).
    CONSTRAINT "patient_access_links_scopes_check" CHECK (
      "scopes" IS NOT NULL AND cardinality("scopes") BETWEEN 1 AND 3
      AND array_position("scopes", NULL) IS NULL
    ),
    -- Nunca más de 5 fallos (el quinto bloquea).
    CONSTRAINT "patient_access_links_attempts_check" CHECK ("failedAttempts" BETWEEN 0 AND 5),
    -- Revocado con quién y cuándo, o ninguno de los dos.
    CONSTRAINT "patient_access_links_revoked_check" CHECK (
      ("revokedAt" IS NULL) = ("revokedById" IS NULL)
    ),
    CONSTRAINT "patient_access_links_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE UNIQUE INDEX "patient_access_links_token_hash_key" ON "patient_access_links"("tokenHash");
-- Enlaces del paciente (lista de la ficha) y lado hijo de la FK al paciente.
CREATE INDEX "patient_access_links_patient_idx"
  ON "patient_access_links"("tenantId", "patientId", "createdAt" DESC);
-- Lados hijos de las FK a users.
CREATE INDEX "patient_access_links_created_by_idx" ON "patient_access_links"("createdById");
CREATE INDEX "patient_access_links_revoked_by_idx" ON "patient_access_links"("revokedById");

-- Al insertar: apartados sin repetir, contador a cero, sin bloqueo, sin
-- revocar ni accesos, y la hora de alta la pone el servidor.
CREATE FUNCTION public.dx_patient_access_links_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (SELECT count(DISTINCT s) FROM pg_catalog.unnest(NEW."scopes") AS s)
     <> pg_catalog.cardinality(NEW."scopes") THEN
    RAISE EXCEPTION 'patient_access_links: apartados repetidos (DX-101)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."failedAttempts" <> 0 OR NEW."lockedUntil" IS NOT NULL
     OR NEW."revokedAt" IS NOT NULL OR NEW."lastViewedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'patient_access_links: un enlace nace vivo y sin accesos (DX-101)'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  IF NEW."expiresAt" <= NEW."createdAt" THEN
    RAISE EXCEPTION 'patient_access_links: la caducidad tiene que ser futura (DX-101)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patient_access_links_before_insert"
  BEFORE INSERT ON "patient_access_links"
  FOR EACH ROW EXECUTE FUNCTION public.dx_patient_access_links_before_insert();

-- Guarda:
--   · DELETE/TRUNCATE solo un superusuario (purga y limpieza de test);
--   · uno revocado ya no cambia;
--   · de uno vivo solo cambian el contador, el bloqueo, el último acceso y la
--     revocación (cualquier columna nueva queda protegida sola); la hora de
--     la revocación la pone el servidor.
CREATE FUNCTION public.dx_patient_access_links_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  mutable text[] := ARRAY['failedAttempts', 'lockedUntil', 'lastViewedAt',
    'revokedAt', 'revokedById'];
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
    RAISE EXCEPTION 'patient_access_links: un enlace no se borra, se revoca (DX-101)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'patient_access_links: un enlace revocado no se modifica (DX-101)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - mutable) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'patient_access_links: solo cambian los intentos, el bloqueo, el último acceso y la revocación (DX-101)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."revokedAt" IS NOT NULL THEN
    NEW."revokedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patient_access_links_guard"
  BEFORE UPDATE OR DELETE ON "patient_access_links"
  FOR EACH ROW EXECUTE FUNCTION public.dx_patient_access_links_guard();

CREATE TRIGGER "patient_access_links_no_truncate"
  BEFORE TRUNCATE ON "patient_access_links"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_patient_access_links_guard();

ALTER TABLE "patient_access_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_access_links"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "patient_access_links" FORCE ROW LEVEL SECURITY;

-- La app lee, crea, cuenta fallos y revoca (también bloquea con FOR UPDATE);
-- nunca borra.
REVOKE DELETE, TRUNCATE ON "patient_access_links" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- Fusión de pacientes (DX-266): la lista de 20270107140100 (DX-561) +
-- patient_access_links
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
    'patient_access_links.patientId',
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
