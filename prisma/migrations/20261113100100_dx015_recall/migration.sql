-- DX-015: recall — pacientes con control vencido y lista de llamada.
--
-- Cambios:
--   patient_recalls   recall del paciente, UNO por tipo (HYGIENE, CHECKUP):
--                     intervalo en meses (1–36), día de la última limpieza o
--                     control que fijó el clínico, sede donde se fijó, activo
--                     y desactivación hasta un día con motivo. El vencimiento
--                     NO se guarda: es MAX(lastDoneAt, día de la última cita
--                     atendida) + intervalo, calculado al leer. Mutable (no es
--                     historia clínica); cada cambio deja un audit_event.
--   recall_contacts   contacto de la lista de recall: canal, desenlace (el
--                     vocabulario completo de DX-465 desde ya), nota <= 280,
--                     cita (obligatoria con BOOKED, del MISMO paciente), autor
--                     y fecha (la pone la BD). APPEND-ONLY: ni UPDATE ni
--                     DELETE (una corrección es otro contacto).
--   audit_events      índices parciales de PATIENT_RECALL y RECALL_CONTACT
--                     (DX-102: uno por valor del enum).
--
-- FK COMPUESTAS por tenant (SEC-004): paciente, sede, recall y cita de la
-- MISMA clínica; la cita, además, del MISMO paciente. Las FK van DENTRO del
-- CREATE TABLE (las tablas nacen vacías), así el owner sin BYPASSRLS no
-- necesita ver filas de patients/locations/appointments (DX-134).
--
-- Compatible hacia atrás y aditiva: tres enums, dos tablas vacías, índices,
-- triggers y RLS. Ninguna columna nueva en tablas existentes.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "RecallKind" AS ENUM ('HYGIENE', 'CHECKUP');
CREATE TYPE "RecallContactChannel" AS ENUM ('CALL', 'WHATSAPP_LINK', 'EMAIL', 'IN_PERSON');
CREATE TYPE "RecallContactOutcome" AS ENUM (
  'NO_ANSWER', 'LEFT_MESSAGE', 'CALL_BACK', 'WILL_BOOK', 'DECLINED', 'WRONG_NUMBER', 'BOOKED'
);

-- ---------------------------------------------------------------------------
-- patient_recalls
-- ---------------------------------------------------------------------------
CREATE TABLE "patient_recalls" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "kind" "RecallKind" NOT NULL,
    "intervalMonths" INTEGER NOT NULL,
    "lastDoneAt" DATE NOT NULL,
    "locationId" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "disabledUntil" DATE,
    "disabledReason" TEXT,
    "createdById" UUID NOT NULL,
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patient_recalls_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_recalls_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_recalls_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_recalls_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Mismos topes que la API (400 en español antes); esto es la red.
    CONSTRAINT "patient_recalls_interval_check"
      CHECK ("intervalMonths" BETWEEN 1 AND 36),
    CONSTRAINT "patient_recalls_disabled_reason_check"
      CHECK ("disabledReason" IS NULL OR char_length(btrim("disabledReason")) BETWEEN 1 AND 120),
    -- Un motivo sin fecha no desactiva nada.
    CONSTRAINT "patient_recalls_disabled_check"
      CHECK ("disabledReason" IS NULL OR "disabledUntil" IS NOT NULL)
);

-- Un recall por paciente y tipo: cambiar de sede no lo duplica.
CREATE UNIQUE INDEX "patient_recalls_tenant_patient_kind_key"
  ON "patient_recalls"("tenantId", "patientId", "kind");
-- Destino de la FK compuesta de recall_contacts.
CREATE UNIQUE INDEX "patient_recalls_tenant_id_key"
  ON "patient_recalls"("tenantId", "id");
-- Lado hijo de la FK de la sede.
CREATE INDEX "patient_recalls_tenant_location_idx"
  ON "patient_recalls"("tenantId", "locationId");

-- ---------------------------------------------------------------------------
-- recall_contacts
-- ---------------------------------------------------------------------------
CREATE TABLE "recall_contacts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "recallId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "locationId" UUID,
    "channel" "RecallContactChannel" NOT NULL,
    "outcome" "RecallContactOutcome" NOT NULL,
    "note" TEXT,
    "appointmentId" UUID,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recall_contacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "recall_contacts_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "recall_contacts_recall_fkey"
      FOREIGN KEY ("tenantId", "recallId") REFERENCES "patient_recalls"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "recall_contacts_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "recall_contacts_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- La cita es de la misma clínica Y del mismo paciente.
    CONSTRAINT "recall_contacts_appointment_fkey"
      FOREIGN KEY ("tenantId", "patientId", "appointmentId")
      REFERENCES "appointments"("tenantId", "patientId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "recall_contacts_note_check"
      CHECK ("note" IS NULL OR char_length(btrim("note")) BETWEEN 1 AND 280),
    -- «Agendó» sin la cita no se puede comprobar.
    CONSTRAINT "recall_contacts_booked_check"
      CHECK ("outcome" <> 'BOOKED' OR "appointmentId" IS NOT NULL)
);

-- Historial del recall (lista: último contacto) y del paciente (ficha).
CREATE INDEX "recall_contacts_tenant_recall_created_idx"
  ON "recall_contacts"("tenantId", "recallId", "createdAt" DESC, "id" DESC);
CREATE INDEX "recall_contacts_tenant_patient_created_idx"
  ON "recall_contacts"("tenantId", "patientId", "createdAt" DESC, "id" DESC);
-- Lados hijos de las FK de la sede y de la cita (parciales: casi siempre NULL).
CREATE INDEX "recall_contacts_tenant_location_idx"
  ON "recall_contacts"("tenantId", "locationId") WHERE "locationId" IS NOT NULL;
CREATE INDEX "recall_contacts_tenant_appointment_idx"
  ON "recall_contacts"("tenantId", "patientId", "appointmentId") WHERE "appointmentId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Append-only (trigger). search_path fijo con pg_temp AL FINAL y
-- pg_catalog.pg_roles calificado (SEC-032). El superusuario puede borrar
-- (limpieza de las bases de test); el owner y la app, no.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_recall_contact_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- La fecha del contacto la pone el servidor de BD.
    NEW."createdAt" := CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'recall_contacts es inalterable: un contacto no se edita ni se borra; una corrección es otro contacto (DX-015)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "recall_contacts_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "recall_contacts"
  FOR EACH ROW EXECUTE FUNCTION public.dx_recall_contact_guard();
CREATE TRIGGER "recall_contacts_no_truncate"
  BEFORE TRUNCATE ON "recall_contacts"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_recall_contact_guard();

-- ---------------------------------------------------------------------------
-- RLS FORCE
-- ---------------------------------------------------------------------------
ALTER TABLE "patient_recalls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recall_contacts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "patient_recalls"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY tenant_isolation ON "recall_contacts"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "patient_recalls" FORCE ROW LEVEL SECURITY;
ALTER TABLE "recall_contacts" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- audit_events: índices parciales por valor del enum (DX-102)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "audit_events_resource_patient_recall_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'PATIENT_RECALL';
CREATE INDEX IF NOT EXISTS "audit_events_resource_recall_contact_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'RECALL_CONTACT';
