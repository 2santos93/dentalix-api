-- DX-263: citas futuras en el importador de pacientes (DX-107), con la hoja
-- «citas» del lote.
--
-- Cambios:
--   patient_import_batches  columnas "appointment*": la hoja de citas del lote
--                       (nombre, hash, formato y tamaño del fichero, que NO se
--                       guarda), sus totales del dry-run, errores y avisos por
--                       fila, contadores del trabajo y del deshacer, y cuándo
--                       y quién activó los recordatorios automáticos de sus
--                       citas. ADD COLUMN con DEFAULT constante o NULL: solo
--                       metadatos (no reescribe la tabla).
--   patient_import_appointment_rows  citas preparadas por el dry-run (ya
--                       validadas con las reglas de agendar a mano): documento
--                       del paciente, profesional, sede, tipo, inicio, fin y
--                       motivo. El trabajo las convierte en citas al importar
--                       el lote. SIN FK a patients a propósito (la cita creada
--                       ya la lleva): no entra en el deshacer por catálogo ni
--                       en dx_merge_patients.
--   appointments.import_batch_id  el lote que CREÓ la cita (NULL = a mano) y
--                       su FK compuesta, NOT VALID (no lee filas: la columna
--                       nace entera a NULL). Su índice parcial va en
--                       20261227090100 (CONCURRENTLY, solo en su fichero) y
--                       el VALIDATE en 20261227090200.
--
-- FK COMPUESTAS por tenant (SEC-004); las de la tabla nueva dentro del CREATE
-- TABLE (nace vacía: la validación no lee filas; DX-134). RLS ENABLE + FORCE
-- con la política NULLIF (DX-251). FK directa a tenants con RESTRICT.
--
-- Compatible hacia atrás: solo AÑADE (una tabla vacía, columnas con DEFAULT o
-- NULL y una FK NOT VALID). El código anterior no las lee.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- La hoja de citas del lote
-- ---------------------------------------------------------------------------
ALTER TABLE "patient_import_batches"
  ADD COLUMN "appointmentFileName" TEXT,
  ADD COLUMN "appointmentFileSha256" CHAR(64),
  ADD COLUMN "appointmentFileFormat" "PatientImportFileFormat",
  ADD COLUMN "appointmentFileSizeBytes" INTEGER,
  ADD COLUMN "appointmentTotalRows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "appointmentErrorRows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "appointmentPreparedRows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "appointmentProcessedRows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "appointmentCreatedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "appointmentFailedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "appointmentIssues" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "appointmentUndoneCount" INTEGER,
  ADD COLUMN "appointmentRemindersEnabledAt" TIMESTAMP(3),
  ADD COLUMN "appointmentRemindersEnabledById" UUID;

-- Hoja de citas: los cuatro datos del fichero juntos (o ninguno), contadores
-- no negativos y los recordatorios activados con su quién.
ALTER TABLE "patient_import_batches"
  ADD CONSTRAINT "patient_import_batches_appointment_sheet_check" CHECK (
    ("appointmentFileName" IS NULL) = ("appointmentFileSha256" IS NULL)
    AND ("appointmentFileName" IS NULL) = ("appointmentFileFormat" IS NULL)
    AND ("appointmentFileName" IS NULL) = ("appointmentFileSizeBytes" IS NULL)
    AND ("appointmentFileSha256" IS NULL OR "appointmentFileSha256" ~ '^[0-9a-f]{64}$')
    AND "appointmentTotalRows" >= 0
    AND "appointmentErrorRows" >= 0
    AND "appointmentPreparedRows" >= 0
    AND "appointmentProcessedRows" >= 0
    AND "appointmentCreatedCount" >= 0
    AND "appointmentFailedCount" >= 0
    AND ("appointmentUndoneCount" IS NULL OR "appointmentUndoneCount" >= 0)
    AND ("appointmentRemindersEnabledAt" IS NULL) = ("appointmentRemindersEnabledById" IS NULL)
  ) NOT VALID;

-- ---------------------------------------------------------------------------
-- Citas preparadas
-- ---------------------------------------------------------------------------
CREATE TABLE "patient_import_appointment_rows" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "docKey" TEXT NOT NULL,
    "providerId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "appointmentTypeId" UUID,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "outcome" "PatientImportRowOutcome" NOT NULL DEFAULT 'PENDING',
    "appointmentId" UUID,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "patient_import_appointment_rows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_import_appointment_rows_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_import_appointment_rows_batch_fkey"
      FOREIGN KEY ("tenantId", "batchId") REFERENCES "patient_import_batches"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_import_appointment_rows_appointment_fkey"
      FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "appointments"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_import_appointment_rows_values_check" CHECK (
      "rowNumber" BETWEEN 1 AND 1048576
      AND "docKey" ~ '^[0-9A-Z]{1,30}$'
      AND "end" > "start"
      AND "end" - "start" <= INTERVAL '480 minutes'
      AND ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 1000)
    ),
    -- Creada ⇒ con su cita; solo PENDING, CREATED o FAILED.
    CONSTRAINT "patient_import_appointment_rows_outcome_check" CHECK (
      "outcome" IN ('PENDING', 'CREATED', 'FAILED')
      AND ("outcome" <> 'CREATED' OR "appointmentId" IS NOT NULL)
    )
);

-- Una fila del fichero una vez por lote (y lado hijo de la FK del lote).
CREATE UNIQUE INDEX "patient_import_appointment_rows_tenant_batch_row_key"
  ON "patient_import_appointment_rows"("tenantId", "batchId", "rowNumber");
-- El trabajo las procesa en orden de fila: las PENDING del lote.
CREATE INDEX "patient_import_appointment_rows_tenant_batch_outcome_idx"
  ON "patient_import_appointment_rows"("tenantId", "batchId", "outcome", "rowNumber");
-- Lado hijo de la FK de la cita.
CREATE INDEX "patient_import_appointment_rows_tenant_appointment_idx"
  ON "patient_import_appointment_rows"("tenantId", "appointmentId");

ALTER TABLE "patient_import_appointment_rows" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_import_appointment_rows"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "patient_import_appointment_rows" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- appointments.import_batch_id
-- ---------------------------------------------------------------------------
ALTER TABLE "appointments" ADD COLUMN "import_batch_id" UUID;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_import_batch_fkey"
  FOREIGN KEY ("tenantId", "import_batch_id")
  REFERENCES "patient_import_batches"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
