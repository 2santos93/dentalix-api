-- DX-107: importación de pacientes desde CSV/XLSX por lotes.
--
-- Cambios:
--   patient_import_batches  un fichero subido por un ADMIN: quién, cuándo,
--                       nombre, tamaño y SHA-256 del fichero (el fichero NO se
--                       guarda), mapeo de columnas, estado, totales del
--                       dry-run y del trabajo, y errores/duplicados por fila
--                       (lo que necesita el informe descargable).
--   patient_import_rows  filas preparadas del lote (válidas y duplicadas
--                       contra la BD): lo que el trabajo va a crear o rellenar.
--                       `data` se vacía al procesar la fila o al caducar el
--                       lote; `filledValues` guarda solo lo rellenado en un
--                       paciente existente, para revertirlo al deshacer.
--                       Sede por defecto del lote (la activa al subirlo):
--                       indicativo del país para normalizar teléfonos y sede
--                       de las citas futuras importadas (DX-263).
--                       Los errores (llevan valores del fichero) se vacían al
--                       caducar el lote y a los 90 días de terminado o
--                       deshecho ("issuesPurgedAt").
--   patients.import_batch_id  el lote que CREÓ al paciente (NULL = alta a
--                       mano). «Deshacer lote» retira en blando solo esos.
--
-- Una importación EN MARCHA por clínica: índice único parcial sobre
-- ("tenantId") con status QUEUED o RUNNING.
--
-- FK COMPUESTAS por tenant (SEC-004). Las de las tablas nuevas van DENTRO del
-- CREATE TABLE (nacen vacías; DX-134). La de patients → lote se añade NOT
-- VALID y se valida con patients en NO FORCE (DX-134: con FORCE, la
-- validación no vería las filas); la columna es nueva y está entera a NULL.
--
-- Compatible hacia atrás: solo AÑADE (dos tablas vacías, una columna NULL y
-- sus índices). El código anterior no las conoce; ADD COLUMN sin DEFAULT no
-- reescribe patients.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "patient_import_batches" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSha256" CHAR(64) NOT NULL,
    "fileFormat" "PatientImportFileFormat" NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "status" "PatientImportStatus" NOT NULL DEFAULT 'VALIDATED',
    "duplicateMode" "PatientImportDuplicateMode",
    "columnMapping" JSONB NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "validRows" INTEGER NOT NULL,
    "duplicateRows" INTEGER NOT NULL,
    "errorRows" INTEGER NOT NULL,
    "preparedRows" INTEGER NOT NULL,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "confirmedById" UUID,
    "confirmedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "undoneById" UUID,
    "undoneAt" TIMESTAMP(3),
    "undoneCreated" INTEGER,
    "undoneFilled" INTEGER,
    "issuesPurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patient_import_batches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_import_batches_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_import_batches_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Topes del endpoint (5 MB, 10.000 filas) también en la BD.
    CONSTRAINT "patient_import_batches_file_check" CHECK (
      "fileSha256" ~ '^[0-9a-f]{64}$'
      AND char_length("fileName") BETWEEN 1 AND 255
      AND "fileSizeBytes" BETWEEN 1 AND 5242880
    ),
    CONSTRAINT "patient_import_batches_totals_check" CHECK (
      "totalRows" BETWEEN 0 AND 10000
      AND "validRows" >= 0 AND "duplicateRows" >= 0 AND "errorRows" >= 0
      AND "preparedRows" >= 0 AND "processedRows" BETWEEN 0 AND "preparedRows" AND "createdCount" >= 0 AND "updatedCount" >= 0
      AND "skippedCount" >= 0 AND "failedCount" >= 0
    ),
    CONSTRAINT "patient_import_batches_issues_check" CHECK (jsonb_typeof("issues") = 'array'),
    CONSTRAINT "patient_import_batches_mapping_check" CHECK (jsonb_typeof("columnMapping") = 'object'),
    -- Confirmado ⇒ con modo, quién y cuándo.
    CONSTRAINT "patient_import_batches_confirmed_check" CHECK (
      "status" IN ('VALIDATED', 'EXPIRED')
      OR ("duplicateMode" IS NOT NULL AND "confirmedById" IS NOT NULL AND "confirmedAt" IS NOT NULL)
    ),
    CONSTRAINT "patient_import_batches_undone_check" CHECK (
      ("status" = 'UNDONE') = ("undoneAt" IS NOT NULL AND "undoneById" IS NOT NULL)
    )
);

-- Requisito de las FK compuestas de patients y patient_import_rows.
CREATE UNIQUE INDEX "patient_import_batches_tenant_id_key"
  ON "patient_import_batches"("tenantId", "id");
-- Historial (GET /patient-imports): más reciente primero.
CREATE INDEX "patient_import_batches_tenant_created_idx"
  ON "patient_import_batches"("tenantId", "createdAt" DESC, "id" DESC);
-- Una importación en marcha por clínica.
CREATE UNIQUE INDEX "patient_import_batches_one_active_key"
  ON "patient_import_batches"("tenantId")
  WHERE "status" IN ('QUEUED', 'RUNNING');

CREATE TABLE "patient_import_rows" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "data" JSONB,
    "outcome" "PatientImportRowOutcome" NOT NULL DEFAULT 'PENDING',
    "patientId" UUID,
    "filledValues" JSONB,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "patient_import_rows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_import_rows_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_import_rows_batch_fkey"
      FOREIGN KEY ("tenantId", "batchId") REFERENCES "patient_import_batches"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_import_rows_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_import_rows_row_check" CHECK ("rowNumber" BETWEEN 1 AND 1048576),
    -- Creada o rellenada ⇒ con su paciente; rellenada ⇒ con lo rellenado.
    CONSTRAINT "patient_import_rows_outcome_check" CHECK (
      ("outcome" NOT IN ('CREATED', 'FILLED') OR "patientId" IS NOT NULL)
      AND ("outcome" = 'FILLED') = ("filledValues" IS NOT NULL)
    )
);

-- Filas de un lote en orden (el trabajo las procesa por bloques) y unicidad.
CREATE UNIQUE INDEX "patient_import_rows_tenant_batch_row_key"
  ON "patient_import_rows"("tenantId", "batchId", "rowNumber");
-- Lado hijo de la FK del paciente.
CREATE INDEX "patient_import_rows_tenant_patient_idx"
  ON "patient_import_rows"("tenantId", "patientId");

ALTER TABLE "patient_import_batches" ENABLE ROW LEVEL SECURITY;
-- NULLIF (DX-251): sin tenant en la sesión, la GUC vacía es NULL y no se ve
-- ninguna fila (en vez de un error de cast).
CREATE POLICY tenant_isolation ON "patient_import_batches"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "patient_import_rows" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_import_rows"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- patients.import_batch_id y su FK compuesta. NO FORCE en la hija (patients)
-- mientras se valida (DX-134); la referenciada aún no tiene FORCE.
ALTER TABLE "patients" ADD COLUMN "import_batch_id" UUID;
ALTER TABLE "patients" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "patients" ADD CONSTRAINT "patients_import_batch_fkey"
  FOREIGN KEY ("tenantId", "import_batch_id")
  REFERENCES "patient_import_batches"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_import_batch_fkey";
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;

-- Lado hijo de la FK de la sede.
CREATE INDEX "patient_import_batches_tenant_location_idx"
  ON "patient_import_batches"("tenantId", "locationId");

-- Pacientes de un lote (deshacer) y lado hijo de la FK.
CREATE INDEX "patients_tenant_import_batch_idx"
  ON "patients"("tenantId", "import_batch_id")
  WHERE "import_batch_id" IS NOT NULL;

ALTER TABLE "patient_import_batches" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_import_rows" FORCE ROW LEVEL SECURITY;
