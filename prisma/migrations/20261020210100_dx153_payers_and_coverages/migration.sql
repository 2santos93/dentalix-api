-- DX-153: pagadores de la clínica y cobertura de cada paciente.
--
-- Cambios:
--   payers              catálogo de pagadores POR CLÍNICA (mutua, prepagada,
--                       EPS, empresa, otro). Se retira en blando ("deletedAt" +
--                       active = false); desactivar solo lo oculta de los
--                       selectores.
--   patient_coverages   cobertura de un paciente con un pagador: plan, nº de
--                       afiliado, titular, vigencia (días civiles sin zona),
--                       principal y notas. Se retira en blando ("deletedAt").
--                       "migratedFromInsurerEps" marca las filas que creó el
--                       relleno de patients."insurerEps" (migración siguiente).
--
-- Reglas en la BD (la API responde antes en español; esto es la red):
--   - tipo y país del pagador coinciden: MUTUA_ES exige ES; PREPAGADA_CO y
--     EPS_CO exigen CO; EMPRESA y OTRO admiten cualquiera o ninguno;
--   - vigencia coherente: "validTo" >= "validFrom" cuando ambos existen;
--   - un nombre de pagador por clínica entre los vivos (índice único PARCIAL);
--   - como mucho UNA cobertura principal viva por paciente (índice único
--     PARCIAL);
--   - una sola cobertura migrada por paciente (índice único PARCIAL): hace
--     idempotente el relleno.
--
-- FK COMPUESTAS por tenant (SEC-004): paciente y pagador de la MISMA clínica
-- (por eso payers lleva UNIQUE ("tenantId","id")). Van DENTRO del CREATE TABLE
-- (las tablas nacen vacías), así el owner sin BYPASSRLS no necesita ver filas
-- de patients (DX-134).
--
-- Compatible hacia atrás: solo AÑADE (dos tablas vacías, índices y RLS). El
-- código anterior no las conoce. La copia de patients."insurerEps" va en la
-- migración siguiente (idempotente).
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "payers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PayerType" NOT NULL,
    "country" "ClinicCountry",
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "payers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payers_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Tipo y país coherentes (la API lo valida antes con mensaje en español).
    CONSTRAINT "payers_type_country_check" CHECK (
      ("type" = 'MUTUA_ES' AND "country" = 'ES')
      OR ("type" IN ('PREPAGADA_CO', 'EPS_CO') AND "country" = 'CO')
      OR ("type" IN ('EMPRESA', 'OTRO'))
    )
);

-- Destino de la FK compuesta de patient_coverages.
CREATE UNIQUE INDEX "payers_tenant_id_key" ON "payers"("tenantId", "id");
-- Un nombre por clínica entre los pagadores vivos (retirarlo libera el nombre).
CREATE UNIQUE INDEX "payers_tenant_name_key" ON "payers"("tenantId", "name")
  WHERE "deletedAt" IS NULL;

CREATE TABLE "patient_coverages" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "payerId" UUID NOT NULL,
    "planName" TEXT,
    "memberNumber" TEXT,
    "policyHolderName" TEXT,
    "validFrom" DATE,
    "validTo" DATE,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "migratedFromInsurerEps" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "patient_coverages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_coverages_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTAS: el paciente y el pagador son de la MISMA clínica.
    CONSTRAINT "patient_coverages_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_coverages_payer_fkey"
      FOREIGN KEY ("tenantId", "payerId") REFERENCES "payers"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_coverages_valid_range_check" CHECK (
      "validFrom" IS NULL OR "validTo" IS NULL OR "validTo" >= "validFrom"
    )
);

-- Coberturas de un paciente (ficha). También el lado hijo de la FK del paciente.
CREATE INDEX "patient_coverages_tenant_patient_idx"
  ON "patient_coverages"("tenantId", "patientId", "createdAt");
-- Filtro del listado por pagador; también el lado hijo de la FK del pagador.
CREATE INDEX "patient_coverages_tenant_payer_live_idx"
  ON "patient_coverages"("tenantId", "payerId", "patientId")
  WHERE "deletedAt" IS NULL;
-- Una sola cobertura principal viva por paciente.
CREATE UNIQUE INDEX "patient_coverages_one_primary_key"
  ON "patient_coverages"("tenantId", "patientId")
  WHERE "isPrimary" AND "deletedAt" IS NULL;
-- La copia de insurerEps, una sola vez por paciente (aunque se retire después):
-- hace idempotente la migración del relleno.
CREATE UNIQUE INDEX "patient_coverages_migrated_key"
  ON "patient_coverages"("tenantId", "patientId")
  WHERE "migratedFromInsurerEps";

ALTER TABLE "payers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payers"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "payers" FORCE ROW LEVEL SECURITY;

ALTER TABLE "patient_coverages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_coverages"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "patient_coverages" FORCE ROW LEVEL SECURITY;
