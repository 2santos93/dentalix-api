-- DX-105: listas de precios, convenios y su asignación a pacientes.
--
-- Cambios:
--   price_lists          lista de precios de la clínica (moneda; toda la clínica
--                        o una sede). Se retira en blando ("deletedAt").
--   price_list_items     precio de un procedimiento del catálogo en una lista.
--                        Sin borrado blando: quitar el precio = borrar la fila.
--   agreements           convenio con un pagador: descuento porcentual (global
--                        y/o por categoría) o una lista de precios; sede y
--                        vigencia opcionales. Se retira en blando.
--   patient_agreements   asignación de un convenio a un paciente (vincula, sin
--                        duplicarlo, su cobertura). Se retira en blando; las
--                        filas retiradas son el historial.
--   patient_coverages    UNIQUE ("tenantId","id"): destino de la FK compuesta
--                        de patient_agreements.
--
-- Reglas en la BD (la API responde antes en español; esto es la red):
--   - nombre de lista y de convenio: 2 a 120 caracteres y único por clínica
--     entre los vivos (índice único PARCIAL);
--   - a lo sumo UNA lista ACTIVA y viva por sede (índice único PARCIAL; las de
--     toda la clínica, con "locationId" NULL, no compiten);
--   - precio de lista >= 0 y un solo precio por (lista, procedimiento);
--   - tipo de convenio coherente: PERCENT_DISCOUNT exige "percent" y no admite
--     lista; PRICE_LIST exige lista y no admite "percent" ni "percentByCategory";
--   - "percent" entre 0 y 100; "percentByCategory" es un objeto JSON;
--   - vigencia coherente: "validTo" >= "validFrom" cuando ambos existen;
--   - una sola asignación VIVA por paciente (índice único PARCIAL).
--
-- FK COMPUESTAS por tenant (SEC-004): lista, sede, procedimiento, pagador,
-- convenio, paciente y cobertura son de la MISMA clínica. Van DENTRO del CREATE
-- TABLE (las tablas nacen vacías), así el owner sin BYPASSRLS no necesita ver
-- filas ajenas (DX-134). Las FK de moneda son simples (currencies es global).
-- Las FK no cascadean al borrar (RESTRICT).
--
-- Compatible hacia atrás: solo AÑADE cuatro tablas vacías, un índice único y
-- RLS. El código anterior no las conoce.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

-- Destino de la FK compuesta de patient_agreements.coverageId (la clave es
-- única de por sí por id; no puede fallar por datos).
CREATE UNIQUE INDEX "patient_coverages_tenant_id_key"
  ON "patient_coverages"("tenantId", "id");

-- ---------------------------------------------------------------------------
-- price_lists
-- ---------------------------------------------------------------------------
CREATE TABLE "price_lists" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "locationId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "price_lists_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "price_lists_currency_fkey"
      FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTA: la sede es de la MISMA clínica (NULL = toda la clínica).
    CONSTRAINT "price_lists_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "price_lists_name_length_check" CHECK (char_length(btrim("name")) BETWEEN 2 AND 120),
    CONSTRAINT "price_lists_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$')
);

-- Destino de las FK compuestas de price_list_items y agreements.
CREATE UNIQUE INDEX "price_lists_tenant_id_key" ON "price_lists"("tenantId", "id");
-- Un nombre por clínica entre las listas vivas (retirarla libera el nombre).
CREATE UNIQUE INDEX "price_lists_tenant_name_key" ON "price_lists"("tenantId", "name")
  WHERE "deletedAt" IS NULL;
-- A lo sumo una lista activa y viva por sede. Las de toda la clínica
-- ("locationId" NULL) quedan fuera: pueden coexistir varias.
CREATE UNIQUE INDEX "price_lists_tenant_location_active_key"
  ON "price_lists"("tenantId", "locationId")
  WHERE "active" AND "deletedAt" IS NULL AND "locationId" IS NOT NULL;
-- Lado hijo de la FK de la sede.
CREATE INDEX "price_lists_tenant_location_idx" ON "price_lists"("tenantId", "locationId");

-- ---------------------------------------------------------------------------
-- price_list_items
-- ---------------------------------------------------------------------------
CREATE TABLE "price_list_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "priceListId" UUID NOT NULL,
    "catalogItemId" UUID NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_list_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "price_list_items_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTAS: la lista y el procedimiento son de la MISMA clínica.
    CONSTRAINT "price_list_items_price_list_fkey"
      FOREIGN KEY ("tenantId", "priceListId") REFERENCES "price_lists"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "price_list_items_catalog_item_fkey"
      FOREIGN KEY ("tenantId", "catalogItemId") REFERENCES "dental_catalog_items"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "price_list_items_price_nonneg" CHECK ("price" >= 0)
);

-- Un precio por procedimiento en cada lista; también el lado hijo de la FK de
-- la lista.
CREATE UNIQUE INDEX "price_list_items_tenant_list_item_key"
  ON "price_list_items"("tenantId", "priceListId", "catalogItemId");
-- Lado hijo de la FK del procedimiento.
CREATE INDEX "price_list_items_tenant_catalog_item_idx"
  ON "price_list_items"("tenantId", "catalogItemId");

-- ---------------------------------------------------------------------------
-- agreements
-- ---------------------------------------------------------------------------
CREATE TABLE "agreements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "payerId" UUID NOT NULL,
    "kind" "AgreementKind" NOT NULL,
    "percent" DECIMAL(5,2),
    "percentByCategory" JSONB,
    "priceListId" UUID,
    "locationId" UUID,
    "validFrom" DATE,
    "validTo" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "agreements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agreements_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTAS: pagador, lista y sede son de la MISMA clínica.
    CONSTRAINT "agreements_payer_fkey"
      FOREIGN KEY ("tenantId", "payerId") REFERENCES "payers"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "agreements_price_list_fkey"
      FOREIGN KEY ("tenantId", "priceListId") REFERENCES "price_lists"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "agreements_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "agreements_name_length_check" CHECK (char_length(btrim("name")) BETWEEN 2 AND 120),
    -- Tipo coherente con sus datos.
    CONSTRAINT "agreements_kind_check" CHECK (
      ("kind" = 'PERCENT_DISCOUNT' AND "percent" IS NOT NULL AND "priceListId" IS NULL)
      OR ("kind" = 'PRICE_LIST' AND "priceListId" IS NOT NULL
          AND "percent" IS NULL AND "percentByCategory" IS NULL)
    ),
    CONSTRAINT "agreements_percent_check" CHECK (
      "percent" IS NULL OR ("percent" >= 0 AND "percent" <= 100)
    ),
    CONSTRAINT "agreements_percent_by_category_check" CHECK (
      "percentByCategory" IS NULL OR jsonb_typeof("percentByCategory") = 'object'
    ),
    CONSTRAINT "agreements_valid_range_check" CHECK (
      "validFrom" IS NULL OR "validTo" IS NULL OR "validTo" >= "validFrom"
    )
);

-- Destino de las FK compuestas de patient_agreements y treatment_plan_items.
CREATE UNIQUE INDEX "agreements_tenant_id_key" ON "agreements"("tenantId", "id");
-- Un nombre por clínica entre los convenios vivos.
CREATE UNIQUE INDEX "agreements_tenant_name_key" ON "agreements"("tenantId", "name")
  WHERE "deletedAt" IS NULL;
-- Lado hijo de las FK del pagador, de la lista y de la sede.
CREATE INDEX "agreements_tenant_payer_idx" ON "agreements"("tenantId", "payerId");
CREATE INDEX "agreements_tenant_price_list_idx" ON "agreements"("tenantId", "priceListId");
CREATE INDEX "agreements_tenant_location_idx" ON "agreements"("tenantId", "locationId");

-- ---------------------------------------------------------------------------
-- patient_agreements
-- ---------------------------------------------------------------------------
CREATE TABLE "patient_agreements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "agreementId" UUID NOT NULL,
    "coverageId" UUID,
    "validFrom" DATE,
    "validTo" DATE,
    "notes" TEXT,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "patient_agreements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_agreements_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTAS: paciente, convenio y cobertura son de la MISMA clínica.
    CONSTRAINT "patient_agreements_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_agreements_agreement_fkey"
      FOREIGN KEY ("tenantId", "agreementId") REFERENCES "agreements"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_agreements_coverage_fkey"
      FOREIGN KEY ("tenantId", "coverageId") REFERENCES "patient_coverages"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_agreements_valid_range_check" CHECK (
      "validFrom" IS NULL OR "validTo" IS NULL OR "validTo" >= "validFrom"
    ),
    CONSTRAINT "patient_agreements_notes_length_check" CHECK (
      "notes" IS NULL OR char_length("notes") <= 500
    )
);

-- Historial del paciente (ficha); también el lado hijo de la FK del paciente.
CREATE INDEX "patient_agreements_tenant_patient_idx"
  ON "patient_agreements"("tenantId", "patientId", "createdAt");
-- Una sola asignación viva por paciente (retirarla la pasa al historial).
CREATE UNIQUE INDEX "patient_agreements_one_live_key"
  ON "patient_agreements"("tenantId", "patientId")
  WHERE "deletedAt" IS NULL;
-- Lado hijo de las FK del convenio y de la cobertura.
CREATE INDEX "patient_agreements_tenant_agreement_idx"
  ON "patient_agreements"("tenantId", "agreementId");
CREATE INDEX "patient_agreements_tenant_coverage_idx"
  ON "patient_agreements"("tenantId", "coverageId");

-- ---------------------------------------------------------------------------
-- RLS FORCE por tenant
-- ---------------------------------------------------------------------------
ALTER TABLE "price_lists" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "price_lists"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "price_lists" FORCE ROW LEVEL SECURITY;

ALTER TABLE "price_list_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "price_list_items"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "price_list_items" FORCE ROW LEVEL SECURITY;

ALTER TABLE "agreements" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agreements"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "agreements" FORCE ROW LEVEL SECURITY;

ALTER TABLE "patient_agreements" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_agreements"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "patient_agreements" FORCE ROW LEVEL SECURITY;
