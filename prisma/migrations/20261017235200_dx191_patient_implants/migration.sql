-- DX-191: registro de implantes por paciente (Res. 4816/2008 art. 31 en CO;
-- Reglamento (UE) 2017/745 art. 18 y RD 192/2023 art. 36 en ES) y fecha de
-- entrega de la tarjeta de implante.
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   "PatientImplantKind"   IMPLANT | ABUTMENT | GRAFT | MEMBRANE | OTHER.
--   patient_implants       un componente colocado (paciente, sede, profesional,
--       fecha, diente FDI, ítem del plan opcional, fabricante, sistema,
--       referencia, lote, UDI, medidas, registro sanitario, notas).
--       INALTERABLE: una corrección es ANULAR (motivo, autor y fecha) y
--       registrar otro. Lo único que cambia después de insertar es:
--         - la anulación, una sola vez (columnas void*);
--         - la entrega de la tarjeta, una sola vez (columnas cardDelivered*).
--       Nada más, ni para el owner. DELETE/TRUNCATE solo un superusuario
--       (purga administrativa y limpieza de las bases de test), como el
--       odontograma (DX-120).
--   Retención (DX-039): colocar un implante es una atención clínica; un
--       trigger adelanta patients.last_attention_at con la fecha de colocación
--       (con tope en hoy), así el bloqueo de archivo y borrado cuenta con él.
--
-- La FK al ítem del plan va en 20261017235400 (su índice único destino se crea
-- CONCURRENTLY en 20261017235300). Grants: ALTER DEFAULT PRIVILEGES ya cubre a
-- dentalix_app en la tabla nueva.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "PatientImplantKind" AS ENUM ('IMPLANT', 'ABUTMENT', 'GRAFT', 'MEMBRANE', 'OTHER');

CREATE TABLE "patient_implants" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "professionalId" UUID NOT NULL,
    "placedOn" DATE NOT NULL,
    "toothNumber" TEXT NOT NULL,
    "treatmentPlanItemId" UUID,
    "kind" "PatientImplantKind" NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "system" TEXT,
    "reference" TEXT NOT NULL,
    "lot" TEXT NOT NULL,
    "udi" TEXT,
    "diameterMm" DECIMAL(4,2),
    "lengthMm" DECIMAL(4,2),
    "sanitaryRegistration" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "cardDeliveredAt" TIMESTAMP(3),
    "cardDeliveredById" UUID,

    CONSTRAINT "patient_implants_pkey" PRIMARY KEY ("id"),
    -- Mismo patrón FDI que el odontograma (permanentes y temporales).
    CONSTRAINT "patient_implants_tooth_fdi"
      CHECK ("toothNumber" ~ '^([1-4][1-8]|[5-8][1-5])$'),
    -- Obligatorios con contenido (la API responde 400 en español antes).
    CONSTRAINT "patient_implants_manufacturer_len"
      CHECK (char_length(btrim("manufacturer")) BETWEEN 1 AND 120),
    CONSTRAINT "patient_implants_reference_len"
      CHECK (char_length(btrim("reference")) BETWEEN 1 AND 80),
    CONSTRAINT "patient_implants_lot_len"
      CHECK (char_length(btrim("lot")) BETWEEN 1 AND 80),
    CONSTRAINT "patient_implants_system_len"
      CHECK ("system" IS NULL OR char_length(btrim("system")) BETWEEN 1 AND 120),
    CONSTRAINT "patient_implants_udi_len"
      CHECK ("udi" IS NULL OR char_length(btrim("udi")) BETWEEN 1 AND 255),
    CONSTRAINT "patient_implants_sanitary_registration_len"
      CHECK ("sanitaryRegistration" IS NULL OR char_length(btrim("sanitaryRegistration")) BETWEEN 1 AND 80),
    CONSTRAINT "patient_implants_notes_len"
      CHECK ("notes" IS NULL OR char_length("notes") <= 1000),
    CONSTRAINT "patient_implants_diameter_range"
      CHECK ("diameterMm" IS NULL OR ("diameterMm" > 0 AND "diameterMm" <= 20)),
    CONSTRAINT "patient_implants_length_range"
      CHECK ("lengthMm" IS NULL OR ("lengthMm" > 0 AND "lengthMm" <= 40)),
    -- ANULADO <=> fecha, autor y motivo. IS NOT NULL explícito: con NULL,
    -- char_length(...) da NULL y un CHECK con NULL PASA.
    CONSTRAINT "patient_implants_void_check" CHECK (
      ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
      OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL
          AND "voidReason" IS NOT NULL
          AND char_length(btrim("voidReason")) BETWEEN 3 AND 500)
    ),
    -- Entrega de la tarjeta: fecha y quién, o nada.
    CONSTRAINT "patient_implants_card_delivery_check" CHECK (
      ("cardDeliveredAt" IS NULL) = ("cardDeliveredById" IS NULL)
    )
  );

-- Implantes del paciente por fecha (sección de la ficha y tarjeta de una
-- intervención: placedOn = día).
CREATE INDEX "patient_implants_patient_placed_idx"
  ON "patient_implants"("tenantId", "patientId", "placedOn" DESC, "createdAt");
-- «¿Quién recibió este lote / esta referencia?» (sin distinguir mayúsculas).
-- Expresiones: Prisma no las declara (no generan drift).
CREATE INDEX "patient_implants_tenant_lot_idx"
  ON "patient_implants"("tenantId", upper(btrim("lot")));
CREATE INDEX "patient_implants_tenant_reference_idx"
  ON "patient_implants"("tenantId", upper(btrim("reference")));
-- Catálogo de fabricantes y sistemas usados por la clínica (autocompletar).
CREATE INDEX "patient_implants_tenant_manufacturer_system_idx"
  ON "patient_implants"("tenantId", "manufacturer", "system");
-- Lado hijo de las FK.
CREATE INDEX "patient_implants_tenantId_locationId_idx"
  ON "patient_implants"("tenantId", "locationId");
CREATE INDEX "patient_implants_tenantId_treatmentPlanItemId_idx"
  ON "patient_implants"("tenantId", "treatmentPlanItemId");
CREATE INDEX "patient_implants_professionalId_idx" ON "patient_implants"("professionalId");
CREATE INDEX "patient_implants_voidedById_idx" ON "patient_implants"("voidedById");
CREATE INDEX "patient_implants_cardDeliveredById_idx" ON "patient_implants"("cardDeliveredById");
-- Destino de la búsqueda de auditoría por id (lookup del paciente) bajo RLS.
CREATE UNIQUE INDEX "patient_implants_tenant_id_key" ON "patient_implants"("tenantId", "id");

-- ---------------------------------------------------------------------------
-- FK. DB-028: tenantId explícita. SEC-004: paciente y sede de la MISMA
-- clínica (FK compuestas). RESTRICT: es historia clínica.
-- ---------------------------------------------------------------------------
ALTER TABLE "patient_implants" ADD CONSTRAINT "patient_implants_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_implants" ADD CONSTRAINT "patient_implants_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_implants" ADD CONSTRAINT "patient_implants_tenantId_locationId_fkey"
  FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_implants" ADD CONSTRAINT "patient_implants_professionalId_fkey"
  FOREIGN KEY ("professionalId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_implants" ADD CONSTRAINT "patient_implants_voidedById_fkey"
  FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_implants" ADD CONSTRAINT "patient_implants_cardDeliveredById_fkey"
  FOREIGN KEY ("cardDeliveredById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Inmutabilidad. search_path fijo con pg_temp AL FINAL y catálogo calificado
-- (SEC-032). UPDATE: solo la anulación (void* de NULL a valor) y la entrega
-- de la tarjeta (cardDelivered* de NULL a valor), cada una una vez y sin tocar
-- ninguna otra columna. DELETE/TRUNCATE: solo un superusuario.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "dx_patient_implants_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  void_columns CONSTANT text[] := ARRAY['voidedAt', 'voidedById', 'voidReason'];
  card_columns CONSTANT text[] := ARRAY['cardDeliveredAt', 'cardDeliveredById'];
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'patient_implants es inalterable: no se permite % de un implante registrado; para corregirlo se anula con motivo (DX-191)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - void_columns - card_columns)
       IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - void_columns - card_columns)
     OR (OLD."voidedAt" IS NOT NULL AND (
           NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt"
           OR NEW."voidedById" IS DISTINCT FROM OLD."voidedById"
           OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason"))
     OR (OLD."cardDeliveredAt" IS NOT NULL AND (
           NEW."cardDeliveredAt" IS DISTINCT FROM OLD."cardDeliveredAt"
           OR NEW."cardDeliveredById" IS DISTINCT FROM OLD."cardDeliveredById"))
  THEN
    RAISE EXCEPTION 'patient_implants es inalterable: un implante registrado solo se anula (una vez) o se marca su tarjeta como entregada (DX-191)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patient_implants_immutable"
  BEFORE UPDATE OR DELETE ON "patient_implants"
  FOR EACH ROW EXECUTE FUNCTION "dx_patient_implants_immutable"();
CREATE TRIGGER "patient_implants_no_truncate"
  BEFORE TRUNCATE ON "patient_implants"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_patient_implants_immutable"();
-- La fecha de grabación la pone el servidor (función de DX-038).
CREATE TRIGGER "patient_implants_server_timestamp"
  BEFORE INSERT ON "patient_implants"
  FOR EACH ROW EXECUTE FUNCTION "dx_clinical_record_server_timestamp"();

-- ---------------------------------------------------------------------------
-- Retención (DX-039): la colocación adelanta la última atención del paciente
-- (nunca la atrasa), con tope en el momento actual. SECURITY INVOKER: corre
-- bajo la RLS del rol de la app, solo toca pacientes del tenant de la fila.
-- placedOn es un día civil: se toma su mediodía UTC (cae en el mismo día civil
-- en CO y ES).
-- ---------------------------------------------------------------------------
CREATE FUNCTION "dx_bump_patient_last_attention_implant"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  attended_at timestamp(3);
BEGIN
  attended_at := LEAST(
    NEW."placedOn"::timestamp + interval '12 hours',
    pg_catalog.timezone('UTC', pg_catalog.now())
  );
  UPDATE public."patients"
  SET "last_attention_at" = attended_at
  WHERE "tenantId" = NEW."tenantId"
    AND "id" = NEW."patientId"
    AND ("last_attention_at" IS NULL OR "last_attention_at" < attended_at);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "patient_implants_bump_last_attention"
  AFTER INSERT ON "patient_implants"
  FOR EACH ROW EXECUTE FUNCTION "dx_bump_patient_last_attention_implant"();

-- ---------------------------------------------------------------------------
-- RLS forzada por tenant.
-- ---------------------------------------------------------------------------
ALTER TABLE "patient_implants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_implants" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "patient_implants"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
