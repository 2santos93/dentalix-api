-- DX-053: exportación de los datos de la clínica (ZIP de CSV, Ajustes ›
-- Exportar datos).
--
-- Cambios (todos ADITIVOS):
--   "ClinicExportStatus" enum: PENDING (en cola), RUNNING (generándose),
--                        READY (lista para descargar) o FAILED.
--   clinic_exports       una exportación pedida por un ADMIN: quién y cuándo
--                        la pidió, estado, tamaño del ZIP, filas por fichero,
--                        hasta cuándo se puede descargar (24 h), cuándo y
--                        quién la descargó (UN solo uso) y cuándo se borró el
--                        fichero del almacén (7 días). Es el historial de
--                        Ajustes. No se borra (sin DELETE para dentalix_app).
--
-- Reglas en la BD (la API responde antes con 409/410 en español):
--   * UNA exportación en curso por clínica: índice ÚNICO PARCIAL sobre
--     ("tenantId") WHERE status IN (PENDING, RUNNING). Dos peticiones a la
--     vez: una inserta y la otra choca (P2002 → 409), sin carreras.
--   * Un solo uso: "downloadedAt" y "downloadedById" van juntos y solo en
--     una exportación READY; la API los pone con UPDATE … WHERE
--     "downloadedAt" IS NULL.
--   * READY exige fichero, tamaño, fin y caducidad del enlace; FAILED exige
--     fin y código de error. Tamaño y número de ficheros no negativos.
--   * FK directa a tenants ON DELETE RESTRICT (nace vacía, DX-134). Sin FK a
--     usuarios en "requestedById"/"downloadedById", como el resto de
--     columnas de autor (createdById): el usuario se retira, no se borra.
--   * RLS FORCE por tenant, con NULLIF como el resto.
--
-- Bloqueo: CREATE TABLE de una tabla nueva. lock_timeout por costumbre.
-- Compatible hacia atrás: tabla nueva que el código anterior no conoce.
-- Vuelta atrás: DROP TABLE "clinic_exports"; DROP TYPE "ClinicExportStatus".

SET LOCAL lock_timeout = '5s';

CREATE TYPE "ClinicExportStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'FAILED');

CREATE TABLE "clinic_exports" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "status" "ClinicExportStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" UUID NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorCode" VARCHAR(40),
    "fileKey" TEXT,
    "sizeBytes" BIGINT,
    "fileCount" INTEGER,
    "rowCounts" JSONB,
    "downloadExpiresAt" TIMESTAMP(3),
    "downloadedAt" TIMESTAMP(3),
    "downloadedById" UUID,
    "fileDeletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clinic_exports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "clinic_exports_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "clinic_exports_ready_check" CHECK (
      "status" <> 'READY' OR (
        "fileKey" IS NOT NULL AND "sizeBytes" IS NOT NULL
        AND "completedAt" IS NOT NULL AND "downloadExpiresAt" IS NOT NULL
      )
    ),
    CONSTRAINT "clinic_exports_failed_check" CHECK (
      "status" <> 'FAILED' OR ("completedAt" IS NOT NULL AND "errorCode" IS NOT NULL)
    ),
    CONSTRAINT "clinic_exports_download_check" CHECK (
      ("downloadedAt" IS NULL) = ("downloadedById" IS NULL)
      AND ("downloadedAt" IS NULL OR "status" = 'READY')
    ),
    CONSTRAINT "clinic_exports_sizes_check" CHECK (
      ("sizeBytes" IS NULL OR "sizeBytes" >= 0)
      AND ("fileCount" IS NULL OR "fileCount" >= 0)
    ),
    CONSTRAINT "clinic_exports_error_code_check" CHECK (
      "errorCode" IS NULL OR "errorCode" ~ '^[A-Z][A-Z0-9_]{0,39}$'
    )
);

-- Una sola en curso por clínica (409 sin carreras).
CREATE UNIQUE INDEX "clinic_exports_one_active_key"
  ON "clinic_exports"("tenantId") WHERE "status" IN ('PENDING', 'RUNNING');
-- Historial de Ajustes (más recientes primero) y lado hijo de la FK.
CREATE INDEX "clinic_exports_tenant_requested_idx"
  ON "clinic_exports"("tenantId", "requestedAt" DESC, "id" DESC);

ALTER TABLE "clinic_exports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clinic_exports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clinic_exports"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- El historial no se borra.
GRANT SELECT, INSERT, UPDATE ON "clinic_exports" TO dentalix_app;
REVOKE DELETE, TRUNCATE ON "clinic_exports" FROM dentalix_app;
