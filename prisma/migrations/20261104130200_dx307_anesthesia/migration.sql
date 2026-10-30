-- DX-307: anestesia local estructurada en la evolución.
--
-- Cambios (solo AÑADE: tablas y un tipo nuevos; nada existente cambia):
--   AnesthesiaTechnique         técnica (infiltrativa, troncular,
--                               intraligamentosa, intrapulpar, intraósea).
--   anesthetic_products         catálogo de anestésicos de cada clínica:
--                               principio activo, concentración (%),
--                               vasoconstrictor, ml por carpule, mg/kg máximo
--                               y tope absoluto en mg. Datos editables por el
--                               ADMIN (se desactivan, no se borran).
--   anesthesia_administrations  anestesia administrada en una evolución, con
--                               la COPIA de los valores del catálogo, los mg,
--                               el peso usado, el acumulado de la evolución,
--                               los avisos que calculó el servidor y el motivo
--                               de la confirmación. INALTERABLE como la
--                               evolución (DX-038): mismo trigger, fecha del
--                               servidor y corrección por adenda.
--
-- Las dos tablas: FK de tenantId explícita (DB-028), FK compuestas por
-- clínica (SEC-004) y RLS FORZADA por tenant. Grants: ALTER DEFAULT
-- PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "AnesthesiaTechnique" AS ENUM ('INFILTRATION', 'NERVE_BLOCK', 'INTRALIGAMENTARY', 'INTRAPULPAL', 'INTRAOSSEOUS');

-- ---------------------------------------------------------------------------
-- 1. Catálogo
-- ---------------------------------------------------------------------------
CREATE TABLE "anesthetic_products" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "activeIngredient" TEXT NOT NULL,
    "concentrationPct" DECIMAL(4,2) NOT NULL,
    "vasoconstrictor" TEXT,
    "mlPerCarpule" DECIMAL(3,2) NOT NULL,
    "maxMgPerKg" DECIMAL(4,2) NOT NULL,
    "maxAbsoluteMg" DECIMAL(6,1) NOT NULL,
    "sampleCode" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "anesthetic_products_pkey" PRIMARY KEY ("id"),
    -- Mismos rangos que el DTO (defensa en profundidad ante un INSERT por SQL).
    CONSTRAINT "anesthetic_products_name_len"
      CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
    CONSTRAINT "anesthetic_products_ingredient_len"
      CHECK (char_length(btrim("activeIngredient")) BETWEEN 1 AND 80),
    CONSTRAINT "anesthetic_products_values_range" CHECK (
      "concentrationPct" > 0 AND "concentrationPct" <= 10
      AND "mlPerCarpule" > 0 AND "mlPerCarpule" <= 5
      AND "maxMgPerKg" > 0 AND "maxMgPerKg" <= 20
      AND "maxAbsoluteMg" > 0 AND "maxAbsoluteMg" <= 2000
    )
);

CREATE UNIQUE INDEX "anesthetic_products_tenant_id_key" ON "anesthetic_products"("tenantId", "id");
CREATE UNIQUE INDEX "anesthetic_products_tenant_name_key" ON "anesthetic_products"("tenantId", "name");
-- Listado del selector (activos por nombre) y de Ajustes.
CREATE INDEX "anesthetic_products_tenant_active_name_idx" ON "anesthetic_products"("tenantId", "active", "name");
-- «Cargar sugeridos» no duplica un ejemplo ya cargado.
CREATE UNIQUE INDEX "anesthetic_products_tenant_sample_key"
  ON "anesthetic_products"("tenantId", "sampleCode") WHERE "sampleCode" IS NOT NULL;

ALTER TABLE "anesthetic_products" ADD CONSTRAINT "anesthetic_products_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "anesthetic_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "anesthetic_products" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "anesthetic_products"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- 2. Anestesia de una evolución (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE "anesthesia_administrations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "clinicalEntryId" UUID NOT NULL,
    "locationId" UUID,
    "anestheticId" UUID NOT NULL,
    "anestheticName" TEXT NOT NULL,
    "activeIngredient" TEXT NOT NULL,
    "concentrationPct" DECIMAL(4,2) NOT NULL,
    "vasoconstrictor" TEXT,
    "mlPerCarpule" DECIMAL(3,2) NOT NULL,
    "maxMgPerKg" DECIMAL(4,2) NOT NULL,
    "maxAbsoluteMg" DECIMAL(6,1) NOT NULL,
    "carpules" DECIMAL(4,2) NOT NULL,
    "doseMg" DECIMAL(6,1) NOT NULL,
    "technique" "AnesthesiaTechnique" NOT NULL,
    "site" TEXT,
    "lot" TEXT,
    "administeredAt" TIMESTAMP(3) NOT NULL,
    "weightKg" DECIMAL(4,1),
    "weightSource" TEXT,
    "cumulativeMg" DECIMAL(7,1) NOT NULL,
    "cumulativePercent" INTEGER,
    "safetyRulesVersion" TEXT NOT NULL,
    "safetyAlerts" JSONB NOT NULL,
    "overrideReason" TEXT,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anesthesia_administrations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "anesthesia_administrations_carpules_range"
      CHECK ("carpules" > 0 AND "carpules" <= 20),
    CONSTRAINT "anesthesia_administrations_weight_range"
      CHECK ("weightKg" IS NULL OR ("weightKg" > 0 AND "weightKg" < 400)),
    CONSTRAINT "anesthesia_administrations_weight_source"
      CHECK (("weightKg" IS NULL AND "weightSource" IS NULL)
          OR ("weightKg" IS NOT NULL AND "weightSource" IN ('ANAMNESIS', 'ENTERED'))),
    CONSTRAINT "anesthesia_administrations_site_len"
      CHECK ("site" IS NULL OR char_length("site") <= 120),
    CONSTRAINT "anesthesia_administrations_lot_len"
      CHECK ("lot" IS NULL OR char_length("lot") <= 60),
    CONSTRAINT "anesthesia_administrations_override_len"
      CHECK ("overrideReason" IS NULL OR char_length(btrim("overrideReason")) BETWEEN 10 AND 500)
);

-- Anestesia de una evolución en orden (y de todas las del paciente: la ficha).
CREATE INDEX "anesthesia_administrations_entry_idx"
  ON "anesthesia_administrations"("tenantId", "patientId", "clinicalEntryId", "administeredAt");
-- Lado hijo de la FK al catálogo.
CREATE INDEX "anesthesia_administrations_anesthetic_idx"
  ON "anesthesia_administrations"("tenantId", "anestheticId");
-- Lado hijo de la FK a la sede (parcial: las evoluciones legacy no tienen).
CREATE INDEX "anesthesia_administrations_location_idx"
  ON "anesthesia_administrations"("tenantId", "locationId") WHERE "locationId" IS NOT NULL;

ALTER TABLE "anesthesia_administrations" ADD CONSTRAINT "anesthesia_administrations_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "anesthesia_administrations" ADD CONSTRAINT "anesthesia_administrations_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "anesthesia_administrations" ADD CONSTRAINT "anesthesia_administrations_tenantId_patientId_clinicalEntr_fkey"
  FOREIGN KEY ("tenantId", "patientId", "clinicalEntryId") REFERENCES "clinical_entries"("tenantId", "patientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "anesthesia_administrations" ADD CONSTRAINT "anesthesia_administrations_tenantId_anestheticId_fkey"
  FOREIGN KEY ("tenantId", "anestheticId") REFERENCES "anesthetic_products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "anesthesia_administrations" ADD CONSTRAINT "anesthesia_administrations_tenantId_locationId_fkey"
  FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "anesthesia_administrations" ADD CONSTRAINT "anesthesia_administrations_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Inalterable y con la fecha del servidor, como la evolución (DX-038).
CREATE TRIGGER "anesthesia_administrations_immutable"
  BEFORE UPDATE OR DELETE ON "anesthesia_administrations"
  FOR EACH ROW EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"();
CREATE TRIGGER "anesthesia_administrations_no_truncate"
  BEFORE TRUNCATE ON "anesthesia_administrations"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"();
CREATE TRIGGER "anesthesia_administrations_server_timestamp"
  BEFORE INSERT ON "anesthesia_administrations"
  FOR EACH ROW EXECUTE FUNCTION "dx_clinical_record_server_timestamp"();

ALTER TABLE "anesthesia_administrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "anesthesia_administrations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "anesthesia_administrations"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Los registros nunca se borran (además del trigger); el catálogo se
-- desactiva, no se borra.
REVOKE DELETE, TRUNCATE ON "anesthesia_administrations" FROM dentalix_app;
REVOKE DELETE, TRUNCATE ON "anesthetic_products" FROM dentalix_app;
