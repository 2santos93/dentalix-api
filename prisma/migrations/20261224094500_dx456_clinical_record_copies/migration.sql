-- DX-456: «Copia de la historia clínica» de un paciente.
--
-- Cambios:
--   clinical_record_copies   UNA fila por generación: paciente, sede en la que
--                            se generó, período (días civiles de la sede,
--                            ambos inclusive), secciones elegidas, quién la
--                            generó y, opcional, a quién se entregó (texto
--                            libre corto). NO guarda contenido clínico: el
--                            documento se arma al leerlo, con lo registrado
--                            hasta el momento de la generación.
--
-- Por qué una tabla y no solo la auditoría: «entregado a» es texto libre y la
-- metadata de `audit_events` es una lista cerrada sin texto (DX-009). El
-- evento EXPORT lleva el id de esta fila (`params.copyId`), el período y los
-- códigos de las secciones; el texto vive aquí, como el «Otro» de DX-439.
--
-- Reglas en la BD:
--   * FK COMPUESTAS por tenant (SEC-004): paciente y sede de la MISMA clínica.
--   * Período válido (desde <= hasta), de 1 a 8 secciones sin repetir,
--     «entregado a» de 1 a 120 caracteres, sin espacios en los bordes ni
--     saltos de línea.
--   * Append-only (trigger + REVOKE): solo un superusuario borra (limpieza de
--     tests); "createdAt" lo pone la BD en UTC.
--   * RLS FORCE con NULLIF, como el resto de tablas de clínica.
--
-- Compatible hacia atrás: AÑADE un enum y una tabla vacía.

SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ClinicalRecordCopySection" AS ENUM (
  'EVOLUTIONS',
  'DIAGNOSES',
  'ANAMNESIS',
  'ODONTOGRAM',
  'ANESTHESIA_SEDATION',
  'CONSENTS',
  'PRESCRIPTIONS',
  'APPOINTMENTS'
);

-- CreateTable
CREATE TABLE "clinical_record_copies" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "rangeFrom" DATE NOT NULL,
    "rangeTo" DATE NOT NULL,
    "sections" "ClinicalRecordCopySection"[] NOT NULL,
    "deliveredTo" VARCHAR(120),
    "generatedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinical_record_copies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "clinical_record_copies_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "clinical_record_copies_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId")
      REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "clinical_record_copies_location_fkey"
      FOREIGN KEY ("tenantId", "locationId")
      REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "clinical_record_copies_generated_by_fkey"
      FOREIGN KEY ("generatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "clinical_record_copies_range_check"
      CHECK ("rangeFrom" <= "rangeTo"),
    CONSTRAINT "clinical_record_copies_sections_check"
      CHECK (
        cardinality("sections") BETWEEN 1 AND 8
        AND array_position("sections", NULL) IS NULL
      ),
    CONSTRAINT "clinical_record_copies_delivered_to_check"
      CHECK (
        "deliveredTo" IS NULL
        OR (
          "deliveredTo" = btrim("deliveredTo")
          AND char_length("deliveredTo") BETWEEN 1 AND 120
          AND "deliveredTo" !~ '[[:cntrl:]]'
        )
      )
);

-- Secciones sin repetir: un CHECK no admite subconsultas, así que lo mira un
-- trigger (barato: como mucho 8 elementos).
CREATE FUNCTION public.clinical_record_copies_distinct_sections() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (SELECT count(DISTINCT s) FROM unnest(NEW."sections") AS s)
       <> cardinality(NEW."sections") THEN
    RAISE EXCEPTION 'clinical_record_copies_sections_check: secciones repetidas'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "clinical_record_copies_distinct_sections"
  BEFORE INSERT ON "clinical_record_copies"
  FOR EACH ROW EXECUTE FUNCTION public.clinical_record_copies_distinct_sections();

-- CreateIndex
CREATE UNIQUE INDEX "clinical_record_copies_tenant_id_key" ON "clinical_record_copies"("tenantId", "id");

-- La ficha lista las generaciones del paciente, la más reciente primero.
CREATE INDEX "clinical_record_copies_tenant_patient_created_idx"
  ON "clinical_record_copies"("tenantId", "patientId", "createdAt" DESC);

CREATE INDEX "clinical_record_copies_tenant_location_idx"
  ON "clinical_record_copies"("tenantId", "locationId");

CREATE INDEX "clinical_record_copies_generated_by_idx"
  ON "clinical_record_copies"("generatedById");

-- ---------------------------------------------------------------------------
-- Fecha del servidor y append-only: sin UPDATE; DELETE/TRUNCATE solo de un
-- superusuario (como closing_queue_dismissals, DX-439).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx456_server_created_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "clinical_record_copies_server_created_at"
  BEFORE INSERT ON "clinical_record_copies"
  FOR EACH ROW EXECUTE FUNCTION public.dx456_server_created_at();

CREATE FUNCTION public.clinical_record_copies_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND public.dx_cash_is_superuser() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es un registro de auditoría: no admite % (DX-456)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "clinical_record_copies_append_only"
  BEFORE UPDATE OR DELETE ON "clinical_record_copies"
  FOR EACH ROW EXECUTE FUNCTION public.clinical_record_copies_append_only();
CREATE TRIGGER "clinical_record_copies_no_truncate"
  BEFORE TRUNCATE ON "clinical_record_copies"
  FOR EACH STATEMENT EXECUTE FUNCTION public.clinical_record_copies_append_only();

-- ---------------------------------------------------------------------------
-- RLS FORCE
-- ---------------------------------------------------------------------------
ALTER TABLE "clinical_record_copies" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "clinical_record_copies"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "clinical_record_copies" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Grants: los privilegios por defecto dan a dentalix_app SELECT, INSERT,
-- UPDATE y DELETE; aquí se recortan (REVOKE de tabla primero).
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON "clinical_record_copies" FROM dentalix_app;
GRANT SELECT, INSERT ON "clinical_record_copies" TO dentalix_app;
