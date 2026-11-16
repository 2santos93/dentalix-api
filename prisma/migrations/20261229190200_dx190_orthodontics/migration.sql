-- DX-190: caso de ortodoncia por paciente, control estructurado y lista de
-- pacientes atrasados o sin próxima cita.
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   tenants."orthodonticsEnabled"  la clínica activa el módulo en Ajustes
--                       (apagado de fábrica). ADD COLUMN con DEFAULT
--                       constante: solo metadatos.
--   tenants."orthoWireGauges"      calibres de arco que ofrece el formulario
--                       del control (lista editable por la clínica; la de
--                       fábrica, en pulgadas, como los venden los
--                       fabricantes). DEFAULT constante. Su CHECK va NOT
--                       VALID y se valida en 20261229190300.
--   ortho_cases         el caso: paciente, sede, profesional responsable,
--                       plan de tratamiento opcional (FK compuesta con el
--                       paciente), técnica, inicio, meses estimados,
--                       controles previstos, intervalo entre controles
--                       (30 días por defecto), estado con motivo y fechas de
--                       cementado y retiro. UN caso ACTIVE por paciente
--                       (índice único parcial). Un caso FINISHED o ABANDONED
--                       ya no cambia (guarda). Sin DELETE para la app.
--   ortho_visits        el control: cuelga 1:1 de una evolución
--                       (clinical_entries, inalterable, DX-038) creada en la
--                       MISMA transacción; arcos superior e inferior
--                       (material + calibre), elásticos, aparatología,
--                       incidencias, índice de higiene 1–4 y próximo control
--                       propuesto. INALTERABLE: se corrige con una adenda de
--                       su evolución. Ni UPDATE ni DELETE para la app.
--   dx_patient_merge_tables()     + ortho_cases y ortho_visits (DX-266).
--   dx_patient_merge_blockers()   + DX266_TWO_ACTIVE_ORTHO_CASES: dos casos
--                       activos no se pueden juntar (el único parcial); la
--                       clínica cierra uno antes de fusionar.
--
-- DX-285 (cobro de la cuota inicial y por control) colgará sus cargos de
-- ortho_cases y ortho_visits por las claves (tenantId, patientId, id).
--
-- FK COMPUESTAS por tenant (SEC-004) dentro del CREATE TABLE (nacen vacías:
-- la validación no lee filas; DX-134). FK directa a tenants con RESTRICT.
-- RLS ENABLE + FORCE con la política NULLIF (DX-251). Funciones con
-- search_path fijo y pg_temp al final (SEC-032). Grants: ALTER DEFAULT
-- PRIVILEGES ya cubre a dentalix_app; aquí se le quita lo que no usa.
--
-- Vuelta atrás: desplegar la API anterior, recrear dx_patient_merge_tables y
-- dx_patient_merge_blockers con la definición de 20261226140000 y
--   DROP TABLE public."ortho_visits"; DROP TABLE public."ortho_cases";
--   DROP FUNCTION public.dx_ortho_visits_immutable();
--   DROP FUNCTION public.dx_ortho_cases_guard();
--   DROP TYPE "OrthoIncident", "OrthoElasticWear", "OrthoElasticType",
--             "OrthoWireMaterial", "OrthoCaseStatus", "OrthoTechnique";
--   ALTER TABLE public."tenants" DROP COLUMN "orthoWireGauges",
--                                DROP COLUMN "orthodonticsEnabled";

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Ajustes de la clínica
-- ---------------------------------------------------------------------------
ALTER TABLE "tenants"
  ADD COLUMN "orthodonticsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "orthoWireGauges" TEXT[] NOT NULL DEFAULT ARRAY[
    '0.012', '0.014', '0.016', '0.018', '0.020',
    '0.016x0.016', '0.016x0.022', '0.017x0.025', '0.018x0.025', '0.019x0.025'
  ]::TEXT[];

-- Entre 1 y 40 calibres (el contenido de cada uno lo valida la API: 1–20
-- caracteres en una línea, sin repetir).
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_ortho_wire_gauges_check"
  CHECK (pg_catalog.cardinality("orthoWireGauges") BETWEEN 1 AND 40) NOT VALID;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
CREATE TYPE "OrthoTechnique" AS ENUM
  ('METAL_BRACKETS', 'AESTHETIC_BRACKETS', 'SELF_LIGATING', 'ALIGNERS', 'REMOVABLE', 'OTHER');
CREATE TYPE "OrthoCaseStatus" AS ENUM ('ACTIVE', 'RETENTION', 'FINISHED', 'ABANDONED');
CREATE TYPE "OrthoWireMaterial" AS ENUM ('NITI', 'STEEL', 'TMA', 'OTHER');
CREATE TYPE "OrthoElasticType" AS ENUM ('CLASS_II', 'CLASS_III', 'CROSS', 'BOX', 'TRIANGLE', 'OTHER');
CREATE TYPE "OrthoElasticWear" AS ENUM ('FULL_TIME', 'NIGHT', 'PART_TIME');
CREATE TYPE "OrthoIncident" AS ENUM ('BRACKET_DEBONDED', 'BRACKET_BROKEN', 'WIRE_DAMAGED');

-- ---------------------------------------------------------------------------
-- El caso
-- ---------------------------------------------------------------------------
CREATE TABLE "ortho_cases" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "treatmentPlanId" UUID,
    "technique" "OrthoTechnique" NOT NULL,
    "startDate" DATE NOT NULL,
    "estimatedMonths" SMALLINT NOT NULL,
    "plannedVisits" SMALLINT NOT NULL,
    "visitIntervalDays" SMALLINT NOT NULL DEFAULT 30,
    "status" "OrthoCaseStatus" NOT NULL DEFAULT 'ACTIVE',
    "statusReason" TEXT,
    "statusChangedAt" TIMESTAMP(3),
    "statusChangedById" UUID,
    "bondedOn" DATE,
    "debondedOn" DATE,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ortho_cases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ortho_cases_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_cases_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_cases_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El plan tiene que ser de la MISMA clínica Y del MISMO paciente.
    CONSTRAINT "ortho_cases_treatment_plan_fkey"
      FOREIGN KEY ("tenantId", "treatmentPlanId", "patientId")
      REFERENCES "treatment_plans"("tenantId", "id", "patientId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_cases_provider_fkey"
      FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_cases_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_cases_status_changed_by_fkey"
      FOREIGN KEY ("statusChangedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Los mismos topes que la API (400 en español antes).
    CONSTRAINT "ortho_cases_plan_check" CHECK (
      "estimatedMonths" BETWEEN 1 AND 120
      AND "plannedVisits" BETWEEN 1 AND 240
      AND "visitIntervalDays" BETWEEN 7 AND 180
    ),
    CONSTRAINT "ortho_cases_dates_check" CHECK (
      "debondedOn" IS NULL OR "bondedOn" IS NULL OR "debondedOn" >= "bondedOn"
    ),
    -- Motivo: obligatorio al abandonar; 3–500 caracteres cuando lo hay.
    -- IS NOT NULL explícito: con NULL, char_length da NULL y el CHECK PASA.
    CONSTRAINT "ortho_cases_status_check" CHECK (
      ("statusReason" IS NULL OR char_length(btrim("statusReason")) BETWEEN 3 AND 500)
      AND ("status" <> 'ABANDONED' OR "statusReason" IS NOT NULL)
      AND ("statusChangedAt" IS NULL) = ("statusChangedById" IS NULL)
      AND ("status" = 'ACTIVE' OR "statusChangedAt" IS NOT NULL)
    )
);

-- UN caso activo por paciente (la API responde 409 en español antes).
CREATE UNIQUE INDEX "ortho_cases_one_active_key"
  ON "ortho_cases"("tenantId", "patientId") WHERE "status" = 'ACTIVE';
-- Destinos de las FK compuestas (DX-285 colgará de aquí sus cargos).
CREATE UNIQUE INDEX "ortho_cases_tenant_id_key" ON "ortho_cases"("tenantId", "id");
CREATE UNIQUE INDEX "ortho_cases_tenant_patient_id_key"
  ON "ortho_cases"("tenantId", "patientId", "id");
-- Casos del paciente (pestaña de la ficha): el prefijo también sirve la FK.
CREATE INDEX "ortho_cases_patient_created_idx"
  ON "ortho_cases"("tenantId", "patientId", "createdAt" DESC);
-- La lista de la clínica: casos activos por sede.
CREATE INDEX "ortho_cases_active_location_idx"
  ON "ortho_cases"("tenantId", "locationId") WHERE "status" = 'ACTIVE';
-- Lado hijo de las FK.
CREATE INDEX "ortho_cases_tenant_location_idx" ON "ortho_cases"("tenantId", "locationId");
CREATE INDEX "ortho_cases_tenant_plan_idx"
  ON "ortho_cases"("tenantId", "treatmentPlanId", "patientId") WHERE "treatmentPlanId" IS NOT NULL;
CREATE INDEX "ortho_cases_provider_idx" ON "ortho_cases"("providerId");
CREATE INDEX "ortho_cases_created_by_idx" ON "ortho_cases"("createdById");
CREATE INDEX "ortho_cases_status_changed_by_idx"
  ON "ortho_cases"("statusChangedById") WHERE "statusChangedById" IS NOT NULL;

-- Guarda: un caso cerrado (FINISHED o ABANDONED) ya no cambia; de ninguno
-- cambian su clínica, paciente, autor ni fecha de alta. DELETE/TRUNCATE solo
-- un superusuario (purga administrativa y limpieza de las bases de test).
CREATE FUNCTION public.dx_ortho_cases_guard() RETURNS trigger
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
    RAISE EXCEPTION 'ortho_cases es historia clínica: no se permite % de un caso de ortodoncia (DX-190)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" IN ('FINISHED', 'ABANDONED') THEN
    RAISE EXCEPTION 'ortho_cases: un caso de ortodoncia cerrado no se modifica (DX-190)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ortho_cases: la clínica, el paciente, el autor y la fecha de alta de un caso no cambian (DX-190)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ortho_cases_guard"
  BEFORE UPDATE OR DELETE ON "ortho_cases"
  FOR EACH ROW EXECUTE FUNCTION public.dx_ortho_cases_guard();
CREATE TRIGGER "ortho_cases_no_truncate"
  BEFORE TRUNCATE ON "ortho_cases"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_ortho_cases_guard();

ALTER TABLE "ortho_cases" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ortho_cases"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "ortho_cases" FORCE ROW LEVEL SECURITY;

-- La app lee, crea y actualiza (cabecera y estado); nunca borra.
REVOKE DELETE, TRUNCATE ON "ortho_cases" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- El control
-- ---------------------------------------------------------------------------
CREATE TABLE "ortho_visits" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "clinicalEntryId" UUID NOT NULL,
    "visitDate" DATE NOT NULL,
    "upperWireMaterial" "OrthoWireMaterial",
    "upperWireGauge" TEXT,
    "lowerWireMaterial" "OrthoWireMaterial",
    "lowerWireGauge" TEXT,
    "elasticsType" "OrthoElasticType",
    "elasticsWear" "OrthoElasticWear",
    "applianceChanges" TEXT,
    "incidents" "OrthoIncident"[] NOT NULL DEFAULT ARRAY[]::"OrthoIncident"[],
    "hygieneIndex" SMALLINT,
    "nextVisitProposedOn" DATE,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ortho_visits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ortho_visits_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_visits_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El caso y la evolución, de la MISMA clínica Y del MISMO paciente.
    CONSTRAINT "ortho_visits_case_fkey"
      FOREIGN KEY ("tenantId", "patientId", "caseId")
      REFERENCES "ortho_cases"("tenantId", "patientId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_visits_clinical_entry_fkey"
      FOREIGN KEY ("tenantId", "patientId", "clinicalEntryId")
      REFERENCES "clinical_entries"("tenantId", "patientId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ortho_visits_author_fkey"
      FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Arco: material y calibre juntos (o ninguno); calibre de 1–20 caracteres.
    CONSTRAINT "ortho_visits_wires_check" CHECK (
      ("upperWireMaterial" IS NULL) = ("upperWireGauge" IS NULL)
      AND ("lowerWireMaterial" IS NULL) = ("lowerWireGauge" IS NULL)
      AND ("upperWireGauge" IS NULL OR char_length(btrim("upperWireGauge")) BETWEEN 1 AND 20)
      AND ("lowerWireGauge" IS NULL OR char_length(btrim("lowerWireGauge")) BETWEEN 1 AND 20)
    ),
    -- El uso de los elásticos solo con su tipo.
    CONSTRAINT "ortho_visits_elastics_check" CHECK (
      "elasticsWear" IS NULL OR "elasticsType" IS NOT NULL
    ),
    CONSTRAINT "ortho_visits_values_check" CHECK (
      ("hygieneIndex" IS NULL OR "hygieneIndex" BETWEEN 1 AND 4)
      AND ("applianceChanges" IS NULL OR char_length(btrim("applianceChanges")) BETWEEN 1 AND 500)
      AND pg_catalog.cardinality("incidents") <= 3
      AND ("nextVisitProposedOn" IS NULL OR "nextVisitProposedOn" > "visitDate")
    )
);

-- Un control por evolución; también es el lado hijo de la FK a la evolución.
CREATE UNIQUE INDEX "ortho_visits_entry_key"
  ON "ortho_visits"("tenantId", "patientId", "clinicalEntryId");
-- Destinos de FK compuestas (DX-285 colgará de aquí el cargo por control).
CREATE UNIQUE INDEX "ortho_visits_tenant_id_key" ON "ortho_visits"("tenantId", "id");
CREATE UNIQUE INDEX "ortho_visits_tenant_patient_id_key"
  ON "ortho_visits"("tenantId", "patientId", "id");
-- Historial del caso y último control (lista de atrasados); el prefijo sirve
-- la FK al caso.
CREATE INDEX "ortho_visits_case_date_idx"
  ON "ortho_visits"("tenantId", "patientId", "caseId", "visitDate" DESC, "createdAt" DESC);
CREATE INDEX "ortho_visits_author_idx" ON "ortho_visits"("authorId");

-- Inalterable: ni UPDATE ni DELETE (solo un superusuario borra: purga y
-- limpieza de las bases de test). Se corrige con una adenda de su evolución.
CREATE FUNCTION public.dx_ortho_visits_immutable() RETURNS trigger
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
  RAISE EXCEPTION 'ortho_visits es inalterable: no se permite % de un control de ortodoncia; se corrige con una adenda de su evolución (DX-190)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "ortho_visits_immutable"
  BEFORE UPDATE OR DELETE ON "ortho_visits"
  FOR EACH ROW EXECUTE FUNCTION public.dx_ortho_visits_immutable();
CREATE TRIGGER "ortho_visits_no_truncate"
  BEFORE TRUNCATE ON "ortho_visits"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_ortho_visits_immutable();
-- La fecha de grabación la pone el servidor (función de DX-038).
CREATE TRIGGER "ortho_visits_server_timestamp"
  BEFORE INSERT ON "ortho_visits"
  FOR EACH ROW EXECUTE FUNCTION "dx_clinical_record_server_timestamp"();

ALTER TABLE "ortho_visits" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ortho_visits"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "ortho_visits" FORCE ROW LEVEL SECURITY;

-- Append-only (DX-148): la app solo lee e inserta.
REVOKE UPDATE, DELETE, TRUNCATE ON "ortho_visits" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- Fusión de pacientes (DX-266): definición de 20261226140000 + ortodoncia
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

CREATE OR REPLACE FUNCTION public.dx_patient_merge_blockers(p_a uuid, p_b uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.array_remove(ARRAY[
    CASE WHEN EXISTS (
      SELECT 1
        FROM public."appointments" x
        JOIN public."appointments" y
          ON y."tenantId" = x."tenantId" AND y."patientId" = p_b
         AND y."deletedAt" IS NULL AND y."status" <> 'CANCELLED'
         AND pg_catalog.tsrange(x."start", x."end") OPERATOR(pg_catalog.&&) pg_catalog.tsrange(y."start", y."end")
       WHERE x."tenantId" = NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid
         AND x."patientId" = p_a AND x."deletedAt" IS NULL AND x."status" <> 'CANCELLED'
    ) THEN 'DX266_OVERLAPPING_APPOINTMENTS' END,
    CASE WHEN EXISTS (
      SELECT 1
        FROM public."opening_balances" x
        JOIN public."opening_balances" y
          ON y."tenantId" = x."tenantId" AND y."patientId" = p_b
         AND y."importBatchId" = x."importBatchId" AND y."currency" = x."currency"
       WHERE x."tenantId" = NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid
         AND x."patientId" = p_a
    ) THEN 'DX266_OPENING_BALANCE_CONFLICT' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM public."payment_promises" x
       WHERE x."tenantId" = NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid
         AND x."patientId" = p_a AND x."status" = 'OPEN'
    ) AND EXISTS (
      SELECT 1 FROM public."payment_promises" y
       WHERE y."tenantId" = NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid
         AND y."patientId" = p_b AND y."status" = 'OPEN'
    ) THEN 'DX266_OPEN_PAYMENT_PROMISES' END,
    -- DX-190: un caso de ortodoncia ACTIVO por paciente (ortho_cases_one_active_key).
    CASE WHEN EXISTS (
      SELECT 1 FROM public."ortho_cases" x
       WHERE x."tenantId" = NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid
         AND x."patientId" = p_a AND x."status" = 'ACTIVE'
    ) AND EXISTS (
      SELECT 1 FROM public."ortho_cases" y
       WHERE y."tenantId" = NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid
         AND y."patientId" = p_b AND y."status" = 'ACTIVE'
    ) THEN 'DX266_TWO_ACTIVE_ORTHO_CASES' END
  ]::text[], NULL)
$$;
