-- DX-556: prospectos. Quien pregunta por WhatsApp, Instagram o teléfono antes
-- de ser paciente: una bandeja por etapas con responsable, próxima acción,
-- notas comerciales y la conversión en paciente.
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   tenants."leadLostRetentionMonths"  SMALLINT NOT NULL DEFAULT 12: meses
--                        tras los que un prospecto PERDIDO se anonimiza
--                        (1–120; CHECK NOT VALID, su VALIDATE va en
--                        20270114090400). Lo cambia el ADMIN.
--   lead_reasons         catálogo PROPIO de la clínica (motivos de interés y
--                        de pérdida); los predefinidos son constantes de la
--                        API. Borrado lógico; nombre único entre los vivos
--                        de su tipo. Sin DELETE para la app.
--   leads                el prospecto: sede, nombre, teléfono (E.164 único
--                        entre los no anonimizados de la clínica), canal,
--                        motivo de interés, etapa, motivo de pérdida,
--                        responsable, próxima acción, hitos (contacto, cita,
--                        asistencia, pérdida), conversión (paciente enlazado
--                        y primera cita) y anonimización. FK COMPUESTAS por
--                        clínica a sede, paciente y cita; FK a users del
--                        responsable, de quien lo crea y de quien lo
--                        convierte. CHECKs de coherencia por etapa. Guarda:
--                        nace NUEVO y sin conversión; el paciente enlazado no
--                        cambia (salvo la fusión); anonimizado es inmutable.
--                        Sin DELETE para la app. Abre la puerta de la fusión
--                        (DX-266).
--   lead_notes           hilo de notas comerciales, solo de añadir: sin
--                        UPDATE; DELETE solo de las notas de un prospecto ya
--                        anonimizado (la retención).
--   dx_patient_merge_tables()  la de DX-101 (20270111090200) +
--                        leads.convertedPatientId (lista cerrada de DX-266).
--
-- Un prospecto es un dato personal sin relación asistencial: nombre,
-- teléfono, canal y notas comerciales; nunca datos de salud (la API limita
-- las longitudes y la ayuda lo avisa).
--
-- FK sobre tablas con RLS FORCE (DX-134): las de las tablas nuevas van DENTRO
-- de los CREATE TABLE (nacen vacías: la validación no lee filas). FK directa
-- a tenants con RESTRICT. RLS ENABLE + FORCE con la política NULLIF (DX-251).
-- Funciones con search_path fijo y pg_temp al final (SEC-032). Grants: ALTER
-- DEFAULT PRIVILEGES ya cubre a dentalix_app; aquí se le quita lo que no usa.
--
-- Vuelta atrás: desplegar la API anterior, recrear dx_patient_merge_tables con
-- la definición de 20270111090200 y
--   DROP TABLE public."lead_notes"; DROP TABLE public."leads";
--   DROP TABLE public."lead_reasons";
--   DROP FUNCTION public.dx_leads_before_insert();
--   DROP FUNCTION public.dx_leads_guard();
--   DROP FUNCTION public.dx_lead_notes_before_insert();
--   DROP FUNCTION public.dx_lead_notes_guard();
--   DROP TYPE "LeadStage"; DROP TYPE "LeadChannel"; DROP TYPE "LeadReasonKind";
--   ALTER TABLE public."tenants"
--     DROP CONSTRAINT "tenants_lead_lost_retention_months_check",
--     DROP COLUMN "leadLostRetentionMonths";

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Ajuste de la clínica: retención de los prospectos perdidos
-- ---------------------------------------------------------------------------

ALTER TABLE "tenants"
  ADD COLUMN "leadLostRetentionMonths" SMALLINT NOT NULL DEFAULT 12;
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_lead_lost_retention_months_check"
  CHECK ("leadLostRetentionMonths" BETWEEN 1 AND 120) NOT VALID;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------

CREATE TYPE "LeadStage" AS ENUM ('NEW', 'CONTACTED', 'SCHEDULED', 'ATTENDED', 'LOST');
CREATE TYPE "LeadChannel" AS ENUM ('WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'PHONE',
  'WALK_IN', 'REFERRAL', 'WEBSITE', 'OTHER');
CREATE TYPE "LeadReasonKind" AS ENUM ('INTEREST', 'LOSS');

-- ---------------------------------------------------------------------------
-- lead_reasons
-- ---------------------------------------------------------------------------

CREATE TABLE "lead_reasons" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "LeadReasonKind" NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "lead_reasons_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lead_reasons_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "lead_reasons_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "lead_reasons_name_check"
      CHECK (char_length(btrim("name")) BETWEEN 2 AND 60 AND "name" = btrim("name"))
);

-- Nombre único (sin distinguir mayúsculas) entre los vivos de su tipo, y lado
-- hijo de la FK de tenant.
CREATE UNIQUE INDEX "lead_reasons_tenant_kind_name_key"
  ON "lead_reasons"("tenantId", "kind", lower("name")) WHERE "deletedAt" IS NULL;
CREATE INDEX "lead_reasons_created_by_idx" ON "lead_reasons"("createdById");

ALTER TABLE "lead_reasons" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "lead_reasons"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "lead_reasons" FORCE ROW LEVEL SECURITY;

-- Se retira con borrado lógico.
REVOKE DELETE, TRUNCATE ON "lead_reasons" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------------

CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "phoneE164" TEXT,
    "channel" "LeadChannel" NOT NULL,
    "interestReason" TEXT,
    "stage" "LeadStage" NOT NULL DEFAULT 'NEW',
    "lostReason" TEXT,
    "ownerId" UUID,
    "nextActionAt" TIMESTAMP(3),
    "nextActionNote" TEXT,
    "lastContactAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3),
    "attendedAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "convertedPatientId" UUID,
    "convertedAt" TIMESTAMP(3),
    "convertedById" UUID,
    "firstAppointmentId" UUID,
    "anonymizedAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "leads_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "leads_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El paciente y la primera cita, de la MISMA clínica (SEC-004). Con la
    -- columna NULL la FK no se comprueba.
    CONSTRAINT "leads_converted_patient_fkey"
      FOREIGN KEY ("tenantId", "convertedPatientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "leads_first_appointment_fkey"
      FOREIGN KEY ("tenantId", "firstAppointmentId") REFERENCES "appointments"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "leads_owner_fkey"
      FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "leads_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "leads_converted_by_fkey"
      FOREIGN KEY ("convertedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Los topes de la API repetidos como red (400 en español antes).
    CONSTRAINT "leads_values_check" CHECK (
      char_length(btrim("fullName")) BETWEEN 1 AND 120
      AND ("phone" IS NULL OR char_length("phone") BETWEEN 1 AND 40)
      AND ("phoneE164" IS NULL OR "phoneE164" ~ '^\+[1-9][0-9]{6,14}$')
      AND ("interestReason" IS NULL OR char_length(btrim("interestReason")) BETWEEN 2 AND 60)
      AND ("lostReason" IS NULL OR char_length(btrim("lostReason")) BETWEEN 2 AND 60)
      AND ("nextActionNote" IS NULL OR char_length(btrim("nextActionNote")) BETWEEN 1 AND 200)
      AND ("nextActionNote" IS NULL OR "nextActionAt" IS NOT NULL)
    ),
    -- Cada etapa con sus hitos:
    --   LOST           motivo y fecha de la pérdida (y solo LOST los tiene);
    --   SCHEDULED      paciente enlazado y fecha de la cita;
    --   ATTENDED       además, fecha de la asistencia.
    -- La conversión va completa o vacía; la primera cita, con paciente.
    CONSTRAINT "leads_stage_check" CHECK (
      (CASE WHEN "stage" = 'LOST'
            THEN "lostReason" IS NOT NULL AND "lostAt" IS NOT NULL
            ELSE "lostReason" IS NULL AND "lostAt" IS NULL END)
      AND ("stage" NOT IN ('SCHEDULED', 'ATTENDED')
           OR ("convertedPatientId" IS NOT NULL AND "scheduledAt" IS NOT NULL))
      AND ("stage" <> 'ATTENDED' OR "attendedAt" IS NOT NULL)
      AND ("attendedAt" IS NULL OR "scheduledAt" IS NOT NULL)
      AND (("convertedPatientId" IS NULL) = ("convertedAt" IS NULL)
           AND ("convertedPatientId" IS NULL) = ("convertedById" IS NULL))
      AND ("firstAppointmentId" IS NULL OR "convertedPatientId" IS NOT NULL)
    ),
    -- Anonimizado: perdido, sin teléfono ni nota de próxima acción. Vivo:
    -- con teléfono y su E.164.
    CONSTRAINT "leads_anonymized_check" CHECK (
      CASE WHEN "anonymizedAt" IS NULL
           THEN "phone" IS NOT NULL AND "phoneE164" IS NOT NULL
           ELSE "stage" = 'LOST' AND "phone" IS NULL AND "phoneE164" IS NULL
                AND "nextActionAt" IS NULL AND "nextActionNote" IS NULL END
    )
);

-- Destino de la FK compuesta de las notas (SEC-004).
CREATE UNIQUE INDEX "leads_tenant_id_key" ON "leads"("tenantId", "id");
-- Un teléfono, un prospecto vivo por clínica: dos altas a la vez no
-- duplican (la segunda da 409 en la API).
CREATE UNIQUE INDEX "leads_tenant_phone_key"
  ON "leads"("tenantId", "phoneE164") WHERE "phoneE164" IS NOT NULL;
-- Tablero, lista e informe: por sede, etapa y fecha de alta (y lado hijo de
-- la FK a la sede).
CREATE INDEX "leads_location_stage_idx"
  ON "leads"("tenantId", "locationId", "stage", "createdAt" DESC);
CREATE INDEX "leads_created_idx" ON "leads"("tenantId", "createdAt" DESC);
-- «Sin contactar hace más de 24 h» (Mi día): los abiertos.
CREATE INDEX "leads_open_idx"
  ON "leads"("tenantId", "locationId")
  WHERE "stage" IN ('NEW', 'CONTACTED');
-- Retención: perdidos aún sin anonimizar, por fecha de la pérdida.
CREATE INDEX "leads_lost_retention_idx"
  ON "leads"("tenantId", "lostAt")
  WHERE "stage" = 'LOST' AND "anonymizedAt" IS NULL;
-- Lados hijos de las demás FK.
CREATE INDEX "leads_converted_patient_idx"
  ON "leads"("tenantId", "convertedPatientId") WHERE "convertedPatientId" IS NOT NULL;
CREATE INDEX "leads_first_appointment_idx"
  ON "leads"("tenantId", "firstAppointmentId") WHERE "firstAppointmentId" IS NOT NULL;
CREATE INDEX "leads_owner_idx" ON "leads"("ownerId") WHERE "ownerId" IS NOT NULL;
CREATE INDEX "leads_created_by_idx" ON "leads"("createdById");
CREATE INDEX "leads_converted_by_idx"
  ON "leads"("convertedById") WHERE "convertedById" IS NOT NULL;

-- Al insertar: nace NUEVO, sin conversión, sin cita ni hitos, vivo.
CREATE FUNCTION public.dx_leads_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."stage" IS DISTINCT FROM 'NEW'
     OR NEW."convertedPatientId" IS NOT NULL
     OR NEW."firstAppointmentId" IS NOT NULL
     OR NEW."anonymizedAt" IS NOT NULL
     OR NEW."scheduledAt" IS NOT NULL
     OR NEW."attendedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'leads: un prospecto nace nuevo y sin conversión (DX-556)'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "leads_before_insert"
  BEFORE INSERT ON "leads"
  FOR EACH ROW EXECUTE FUNCTION public.dx_leads_before_insert();

-- Guarda:
--   · DELETE/TRUNCATE solo un superusuario (purga y limpieza de test);
--   · anonimizado ya no cambia;
--   · la identidad (clínica, alta, autor) no cambia;
--   · el paciente enlazado y la conversión se fijan una vez (la fusión
--     reasigna el paciente por su puerta);
--   · la primera cita se fija una vez.
CREATE FUNCTION public.dx_leads_guard() RETURNS trigger
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
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'leads: un prospecto no se borra; se marca perdido y se anonimiza (DX-556)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."anonymizedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'leads: un prospecto anonimizado no se modifica (DX-556)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById" THEN
    RAISE EXCEPTION 'leads: la identidad del prospecto no cambia (DX-556)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."convertedPatientId" IS NOT NULL AND (
       NEW."convertedPatientId" IS DISTINCT FROM OLD."convertedPatientId"
       OR NEW."convertedAt" IS DISTINCT FROM OLD."convertedAt"
       OR NEW."convertedById" IS DISTINCT FROM OLD."convertedById") THEN
    RAISE EXCEPTION 'leads: la conversión en paciente se fija una vez (DX-556)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."firstAppointmentId" IS NOT NULL
     AND NEW."firstAppointmentId" IS DISTINCT FROM OLD."firstAppointmentId" THEN
    RAISE EXCEPTION 'leads: la primera cita se fija una vez (DX-556)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "leads_guard"
  BEFORE UPDATE OR DELETE ON "leads"
  FOR EACH ROW EXECUTE FUNCTION public.dx_leads_guard();
CREATE TRIGGER "leads_no_truncate"
  BEFORE TRUNCATE ON "leads"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_leads_guard();

ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "leads"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "leads" FORCE ROW LEVEL SECURITY;

-- La app lee, crea y actualiza (también bloquea con FOR UPDATE); nunca borra.
REVOKE DELETE, TRUNCATE ON "leads" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- lead_notes
-- ---------------------------------------------------------------------------

CREATE TABLE "lead_notes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_notes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lead_notes_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "lead_notes_lead_fkey"
      FOREIGN KEY ("tenantId", "leadId") REFERENCES "leads"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "lead_notes_author_fkey"
      FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El mismo tope que la API.
    CONSTRAINT "lead_notes_body_check" CHECK (char_length(btrim("body")) BETWEEN 1 AND 1000)
);

-- Hilo del prospecto en orden (y lado hijo de la FK al prospecto).
CREATE INDEX "lead_notes_lead_idx" ON "lead_notes"("tenantId", "leadId", "createdAt");
CREATE INDEX "lead_notes_author_idx" ON "lead_notes"("authorId");

-- Al insertar: solo en un prospecto vivo; la hora la pone el servidor.
CREATE FUNCTION public.dx_lead_notes_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."leads" l
     WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."leadId"
       AND l."anonymizedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'lead_notes: el prospecto está anonimizado (DX-556)'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "lead_notes_before_insert"
  BEFORE INSERT ON "lead_notes"
  FOR EACH ROW EXECUTE FUNCTION public.dx_lead_notes_before_insert();

-- Solo de añadir: nunca UPDATE; DELETE solo de las notas de un prospecto ya
-- anonimizado (la retención) o un superusuario (purga y limpieza de test).
CREATE FUNCTION public.dx_lead_notes_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM public."leads" l
     WHERE l."tenantId" = OLD."tenantId" AND l."id" = OLD."leadId"
       AND l."anonymizedAt" IS NOT NULL
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'lead_notes: una nota no se modifica ni se borra (DX-556)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "lead_notes_guard"
  BEFORE UPDATE OR DELETE ON "lead_notes"
  FOR EACH ROW EXECUTE FUNCTION public.dx_lead_notes_guard();
CREATE TRIGGER "lead_notes_no_truncate"
  BEFORE TRUNCATE ON "lead_notes"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_lead_notes_guard();

ALTER TABLE "lead_notes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "lead_notes"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "lead_notes" FORCE ROW LEVEL SECURITY;

-- La app inserta, lee y (solo la retención, sobre un prospecto anonimizado)
-- borra: conserva DELETE; dx_lead_notes_guard impide todo lo demás.

-- ---------------------------------------------------------------------------
-- Fusión de pacientes (DX-266): la lista de 20270111090200 (DX-101) +
-- leads.convertedPatientId
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
    'leads.convertedPatientId',
    'medical_history_reviews.patientId',
    'medical_history_submissions.patientId',
    'medical_history_versions.patientId',
    'online_booking_requests.patientId',
    'online_booking_verifications.patientId',
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
