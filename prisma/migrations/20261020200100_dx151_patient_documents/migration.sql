-- DX-151: documentos del paciente (radiografías, fotos, remisiones,
-- consentimientos firmados escaneados, informes…) adjuntos a su ficha.
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   patient_documents  un fichero subido (paciente, sede, categoría, nombre
--       original, tipo MIME, tamaño, SHA-256 del contenido, clave del bucket,
--       fecha clínica opcional, dientes FDI opcionales, notas, quién lo subió
--       y cuándo). El contenido vive en el bucket (DX-084), nunca en la BD.
--       INALTERABLE: una corrección es ANULAR (motivo, autor y fecha) y subir
--       otro. Lo único que cambia después de insertar es la anulación, una
--       sola vez (columnas void*). Nada más, ni para el owner. DELETE/TRUNCATE
--       solo un superusuario (purga administrativa y limpieza de las bases de
--       test), como los implantes (DX-191).
--   Hash único: el mismo contenido (sha256) no puede estar dos veces VIGENTE
--       en la ficha del mismo paciente; anulado, se puede volver a subir.
--   Hora del servidor: "uploadedAt" y "createdAt" los pone un trigger BEFORE
--       INSERT en UTC (DX-226), sea cual sea lo que mande la API.
--   Retención (DX-039): subir un documento NO es una atención clínica, así
--       que no adelanta patients.last_attention_at (a diferencia de los
--       implantes). El paciente no se puede borrar en duro con documentos
--       (FK RESTRICT) y el documento no se borra nunca desde la app.
--
-- La tabla es nueva (vacía): sus FK se validan sin filas y la RLS FORCE se
-- activa al final (DX-134). Grants: ALTER DEFAULT PRIVILEGES ya cubre a
-- dentalix_app en la tabla nueva. El valor PATIENT_DOCUMENT de
-- "AuditResourceType" y el tipo "PatientDocumentCategory" van en
-- 20261020200000_dx151_enums.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "patient_documents" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "category" "PatientDocumentCategory" NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "clinicalDate" DATE,
    "toothNumbers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "uploadedById" UUID NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_documents_pkey" PRIMARY KEY ("id"),
    -- Tope de subida: 20 MB (20 * 1024 * 1024 bytes), y nunca un fichero vacío.
    CONSTRAINT "patient_documents_size_range"
      CHECK ("sizeBytes" BETWEEN 1 AND 20971520),
    -- SHA-256 del contenido en hex minúsculas (lo calcula la API).
    CONSTRAINT "patient_documents_sha256_hex"
      CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    -- Obligatorios con contenido (la API responde 400 en español antes).
    CONSTRAINT "patient_documents_original_name_len"
      CHECK (char_length(btrim("originalName")) >= 1 AND char_length("originalName") <= 255),
    CONSTRAINT "patient_documents_mime_type_len"
      CHECK (char_length(btrim("mimeType")) BETWEEN 1 AND 255),
    CONSTRAINT "patient_documents_storage_key_len"
      CHECK (char_length(btrim("storageKey")) BETWEEN 1 AND 1024),
    CONSTRAINT "patient_documents_notes_len"
      CHECK ("notes" IS NULL OR char_length("notes") <= 500),
    -- Cada diente con el patrón FDI del odontograma (permanentes y
    -- temporales) y ningún elemento NULL. array_to_string se salta los NULL,
    -- por eso array_position los busca aparte. Vacío: '' encaja con el ?.
    CONSTRAINT "patient_documents_teeth_fdi"
      CHECK (
        pg_catalog.array_position("toothNumbers", NULL) IS NULL
        AND pg_catalog.array_to_string("toothNumbers", ',')
              ~ '^(([1-4][1-8]|[5-8][1-5])(,([1-4][1-8]|[5-8][1-5]))*)?$'
      ),
    -- Como mucho 8 dientes por documento (una radiografía periapical o una
    -- foto de un sector; para más, sin dientes).
    CONSTRAINT "patient_documents_teeth_max"
      CHECK (pg_catalog.cardinality("toothNumbers") <= 8),
    -- ANULADO <=> fecha, autor y motivo. IS NOT NULL explícito: con NULL,
    -- char_length(...) da NULL y un CHECK con NULL PASA.
    CONSTRAINT "patient_documents_void_check" CHECK (
      ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
      OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL
          AND "voidReason" IS NOT NULL
          AND char_length(btrim("voidReason")) BETWEEN 3 AND 500)
    )
  );

-- La clave del objeto en el bucket es de un solo documento.
CREATE UNIQUE INDEX "patient_documents_storageKey_key" ON "patient_documents"("storageKey");
-- El mismo contenido no puede estar dos veces VIGENTE en la ficha del mismo
-- paciente (subida repetida). Parcial: Prisma no lo declara (no genera drift).
CREATE UNIQUE INDEX "patient_documents_active_sha256_key"
  ON "patient_documents"("tenantId", "patientId", "sha256")
  WHERE "voidedAt" IS NULL;
-- Documentos del paciente, los más recientes primero (sección de la ficha).
CREATE INDEX "patient_documents_patient_uploaded_idx"
  ON "patient_documents"("tenantId", "patientId", "uploadedAt" DESC);
-- Filtro por categoría dentro de la ficha.
CREATE INDEX "patient_documents_patient_category_idx"
  ON "patient_documents"("tenantId", "patientId", "category");
-- «Documentos de este diente» (toothNumbers @> ARRAY['36']). La RLS añade el
-- filtro por tenant.
CREATE INDEX "patient_documents_tooth_numbers_idx"
  ON "patient_documents" USING GIN ("toothNumbers");
-- Lado hijo de las FK.
CREATE INDEX "patient_documents_tenantId_locationId_idx"
  ON "patient_documents"("tenantId", "locationId");
CREATE INDEX "patient_documents_uploadedById_idx" ON "patient_documents"("uploadedById");
CREATE INDEX "patient_documents_voidedById_idx" ON "patient_documents"("voidedById");
-- Destino de la búsqueda de auditoría por id (lookup del paciente) bajo RLS.
CREATE UNIQUE INDEX "patient_documents_tenant_id_key" ON "patient_documents"("tenantId", "id");

-- ---------------------------------------------------------------------------
-- FK. DB-028: tenantId explícita. SEC-004: paciente y sede de la MISMA
-- clínica (FK compuestas). RESTRICT: es historia clínica.
-- ---------------------------------------------------------------------------
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_tenantId_locationId_fkey"
  FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_voidedById_fkey"
  FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Inmutabilidad. search_path fijo con pg_temp AL FINAL y catálogo calificado
-- (SEC-032). UPDATE: solo la anulación (void* de NULL a valor), una vez y sin
-- tocar ninguna otra columna. DELETE/TRUNCATE: solo un superusuario.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "dx_patient_documents_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  void_columns CONSTANT text[] := ARRAY['voidedAt', 'voidedById', 'voidReason'];
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'patient_documents es inalterable: no se permite % de un documento del paciente; para corregirlo se anula con motivo (DX-151)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - void_columns)
       IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - void_columns)
     OR (OLD."voidedAt" IS NOT NULL AND (
           NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt"
           OR NEW."voidedById" IS DISTINCT FROM OLD."voidedById"
           OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason"))
  THEN
    RAISE EXCEPTION 'patient_documents es inalterable: un documento del paciente solo se anula, una vez (DX-151)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patient_documents_immutable"
  BEFORE UPDATE OR DELETE ON "patient_documents"
  FOR EACH ROW EXECUTE FUNCTION "dx_patient_documents_immutable"();
CREATE TRIGGER "patient_documents_no_truncate"
  BEFORE TRUNCATE ON "patient_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_patient_documents_immutable"();

-- ---------------------------------------------------------------------------
-- Hora de la subida y del alta del servidor en UTC sea cual sea la zona de la
-- sesión (DX-226) y lo que mande la API: las dos con el MISMO valor.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "dx_patient_documents_server_time"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."uploadedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  NEW."createdAt" := NEW."uploadedAt";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patient_documents_server_time"
  BEFORE INSERT ON "patient_documents"
  FOR EACH ROW EXECUTE FUNCTION "dx_patient_documents_server_time"();

-- ---------------------------------------------------------------------------
-- RLS forzada por tenant.
-- ---------------------------------------------------------------------------
ALTER TABLE "patient_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_documents" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "patient_documents"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
