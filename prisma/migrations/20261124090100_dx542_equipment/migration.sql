-- DX-542 (porción 1): equipos biomédicos de cada sede con su hoja de vida y
-- su programa de mantenimiento (inventario de dotación, sin norma de ningún
-- país en el código).
--
-- Cambios (todos ADITIVOS; tablas nuevas y vacías, ninguna columna en tablas
-- existentes: el código anterior no lee ni escribe nada de esto):
--   "EquipmentCategory"        AUTOCLAVE | DENTAL_UNIT | XRAY | COMPRESSOR |
--                              CURING_LIGHT | ULTRASONIC_SCALER | OTHER.
--   "EquipmentRiskClass"       I | IIA | IIB | III (opcional).
--   "EquipmentStatus"          ACTIVE | RETIRED.
--   "EquipmentMaintenanceKind" PREVENTIVE | CORRECTIVE | CALIBRATION.
--   equipment                  un equipo de una sede (obligatoria) y, si se
--       quiere, de un sillón de ESA sede: nombre, tipo, marca, modelo, nº de
--       serie, registro sanitario (texto libre), clase de riesgo, fecha de
--       adquisición, periodicidad del preventivo en meses y notas. No se
--       borra (sin DELETE para dentalix_app): se da de baja con fecha, motivo
--       y quién, una sola vez (trigger: un equipo dado de baja ya no cambia).
--   equipment_maintenances     la hoja de vida: tipo, fecha, técnico,
--       empresa, descripción, costo opcional con su moneda, el próximo
--       mantenimiento que dejó fijado y quién lo registró. INALTERABLE: lo
--       único que cambia después de insertar es la anulación (fecha, autor y
--       motivo), una vez. DELETE/TRUNCATE solo un superusuario (limpieza de
--       las bases de test), como los implantes (DX-191).
--
-- Reglas en la BD (la API responde antes con 400/404/409 en español; esto es
-- la red):
--   * FK COMPUESTAS por tenant (SEC-004), dentro del CREATE TABLE (las tablas
--     nacen vacías, DX-134: ninguna FK se valida sobre filas existentes):
--       - equipment (tenantId, locationId) → locations: la sede es de la
--         MISMA clínica;
--       - equipment (tenantId, locationId, chairId) → chairs(tenantId,
--         locationId, id): el sillón es de la MISMA clínica y de la MISMA
--         SEDE que el equipo (con "chairId" NULL la FK no mira nada);
--       - equipment_maintenances (tenantId, equipmentId) → equipment(tenantId,
--         id): el mantenimiento es de un equipo de la MISMA clínica.
--   * CHECK de longitudes y sin caracteres de control, periodicidad 1–120,
--     baja coherente (RETIRED <=> fecha, motivo y autor) y no anterior a la
--     adquisición, costo > 0 SIEMPRE con su moneda, próximo posterior a la
--     fecha, anulación coherente (como patient_implants_void_check).
--   * RLS FORCE por tenant en las dos tablas, con NULLIF (DX-251).
--   * createdAt de los mantenimientos la pone el servidor de BD
--     (dx_clinical_record_server_timestamp, DX-038).
--
-- Índices: lista por sede y por nombre (también el lado hijo de la FK a la
-- sede), lista consolidada por nombre, lado hijo de la FK al sillón, y la hoja
-- de vida por (equipo, fecha, alta), que sirve también el último preventivo
-- vivo de cada equipo de la página. Lado hijo de las FK a users y currencies.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya da a dentalix_app SELECT/INSERT/UPDATE
-- en las tablas nuevas; aquí se le quita DELETE y TRUNCATE.
--
-- Vuelta atrás (sin pérdida de datos de otras tablas): DROP TABLE
-- "equipment_maintenances", "equipment"; DROP FUNCTION
-- "dx_equipment_maintenances_immutable"(), "dx_equipment_retired_final"();
-- DROP TYPE de los cuatro enums.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "EquipmentCategory" AS ENUM ('AUTOCLAVE', 'DENTAL_UNIT', 'XRAY', 'COMPRESSOR', 'CURING_LIGHT', 'ULTRASONIC_SCALER', 'OTHER');
CREATE TYPE "EquipmentRiskClass" AS ENUM ('I', 'IIA', 'IIB', 'III');
CREATE TYPE "EquipmentStatus" AS ENUM ('ACTIVE', 'RETIRED');
CREATE TYPE "EquipmentMaintenanceKind" AS ENUM ('PREVENTIVE', 'CORRECTIVE', 'CALIBRATION');

-- ---------------------------------------------------------------------------
-- 1. Equipos
-- ---------------------------------------------------------------------------
CREATE TABLE "equipment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "chairId" UUID,
    "name" VARCHAR(120) NOT NULL,
    "category" "EquipmentCategory" NOT NULL,
    "brand" VARCHAR(80),
    "model" VARCHAR(80),
    "serialNumber" VARCHAR(80),
    "sanitaryRegistration" VARCHAR(80),
    "riskClass" "EquipmentRiskClass",
    "acquiredOn" DATE,
    "maintenanceIntervalMonths" SMALLINT,
    "status" "EquipmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "retiredOn" DATE,
    "retiredReason" TEXT,
    "retiredById" UUID,
    "notes" TEXT,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "equipment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "equipment_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTA: la sede es de la MISMA clínica.
    CONSTRAINT "equipment_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTA: el sillón es de la MISMA clínica y de la MISMA sede.
    CONSTRAINT "equipment_chair_fkey"
      FOREIGN KEY ("tenantId", "locationId", "chairId")
      REFERENCES "chairs"("tenantId", "locationId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "equipment_retired_by_fkey"
      FOREIGN KEY ("retiredById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "equipment_name_check" CHECK (
      "name" = btrim("name")
      AND char_length("name") BETWEEN 1 AND 120
      AND "name" !~ '[[:cntrl:]]'
    ),
    CONSTRAINT "equipment_short_texts_check" CHECK (
      ("brand" IS NULL OR (char_length(btrim("brand")) >= 1 AND "brand" !~ '[[:cntrl:]]'))
      AND ("model" IS NULL OR (char_length(btrim("model")) >= 1 AND "model" !~ '[[:cntrl:]]'))
      AND ("serialNumber" IS NULL OR (char_length(btrim("serialNumber")) >= 1 AND "serialNumber" !~ '[[:cntrl:]]'))
      AND ("sanitaryRegistration" IS NULL OR (char_length(btrim("sanitaryRegistration")) >= 1 AND "sanitaryRegistration" !~ '[[:cntrl:]]'))
    ),
    CONSTRAINT "equipment_notes_check" CHECK ("notes" IS NULL OR char_length("notes") <= 2000),
    CONSTRAINT "equipment_interval_check" CHECK (
      "maintenanceIntervalMonths" IS NULL OR "maintenanceIntervalMonths" BETWEEN 1 AND 120
    ),
    -- DADO DE BAJA <=> fecha, motivo y autor. IS NOT NULL explícito: con
    -- NULL, char_length(...) da NULL y un CHECK con NULL PASA.
    CONSTRAINT "equipment_retired_check" CHECK (
      ("status" = 'ACTIVE' AND "retiredOn" IS NULL AND "retiredReason" IS NULL AND "retiredById" IS NULL)
      OR ("status" = 'RETIRED' AND "retiredOn" IS NOT NULL AND "retiredById" IS NOT NULL
          AND "retiredReason" IS NOT NULL
          AND char_length(btrim("retiredReason")) BETWEEN 3 AND 500)
    ),
    CONSTRAINT "equipment_retired_after_acquired_check" CHECK (
      "retiredOn" IS NULL OR "acquiredOn" IS NULL OR "retiredOn" >= "acquiredOn"
    )
);

-- Destino de la FK compuesta de equipment_maintenances.
CREATE UNIQUE INDEX "equipment_tenant_id_key" ON "equipment"("tenantId", "id");
-- Lista por sede por nombre; también el lado hijo de la FK a la sede.
CREATE INDEX "equipment_tenant_location_name_idx"
  ON "equipment"("tenantId", "locationId", "name", "id");
-- Lista consolidada de la clínica por nombre.
CREATE INDEX "equipment_tenant_name_idx" ON "equipment"("tenantId", "name", "id");
-- Lado hijo de la FK al sillón.
CREATE INDEX "equipment_chair_idx" ON "equipment"("tenantId", "locationId", "chairId");
CREATE INDEX "equipment_retired_by_idx" ON "equipment"("retiredById");

-- Un equipo dado de baja ya no cambia (ni se reactiva). search_path fijo con
-- pg_temp AL FINAL y catálogo calificado (SEC-032).
CREATE FUNCTION "dx_equipment_retired_final"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD."status" = 'RETIRED'
     AND (pg_catalog.to_jsonb(NEW) - 'updatedAt')
         IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'updatedAt')
  THEN
    RAISE EXCEPTION 'equipment: un equipo dado de baja no se modifica ni se reactiva (DX-542)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "equipment_retired_final"
  BEFORE UPDATE ON "equipment"
  FOR EACH ROW EXECUTE FUNCTION "dx_equipment_retired_final"();

ALTER TABLE "equipment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "equipment" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "equipment"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Dar de baja en lugar de borrar: la app no borra equipos.
REVOKE DELETE, TRUNCATE ON "equipment" FROM dentalix_app;
GRANT SELECT, INSERT, UPDATE ON "equipment" TO dentalix_app;

-- ---------------------------------------------------------------------------
-- 2. Mantenimientos (hoja de vida)
-- ---------------------------------------------------------------------------
CREATE TABLE "equipment_maintenances" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "equipmentId" UUID NOT NULL,
    "kind" "EquipmentMaintenanceKind" NOT NULL,
    "performedOn" DATE NOT NULL,
    "technician" VARCHAR(120),
    "company" VARCHAR(120),
    "description" TEXT NOT NULL,
    "cost" DECIMAL(14,2),
    "currency" TEXT,
    "nextDueOn" DATE,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,

    CONSTRAINT "equipment_maintenances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "equipment_maintenances_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTA: el equipo es de la MISMA clínica.
    CONSTRAINT "equipment_maintenances_equipment_fkey"
      FOREIGN KEY ("tenantId", "equipmentId") REFERENCES "equipment"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "equipment_maintenances_currency_fkey"
      FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "equipment_maintenances_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "equipment_maintenances_voided_by_fkey"
      FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "equipment_maintenances_description_check" CHECK (
      char_length(btrim("description")) BETWEEN 1 AND 2000
    ),
    CONSTRAINT "equipment_maintenances_parties_check" CHECK (
      ("technician" IS NULL OR (char_length(btrim("technician")) >= 1 AND "technician" !~ '[[:cntrl:]]'))
      AND ("company" IS NULL OR (char_length(btrim("company")) >= 1 AND "company" !~ '[[:cntrl:]]'))
    ),
    -- Costo > 0 SIEMPRE con su moneda; sin costo, sin moneda.
    CONSTRAINT "equipment_maintenances_cost_check" CHECK (
      ("cost" IS NULL AND "currency" IS NULL)
      OR ("cost" IS NOT NULL AND "cost" > 0 AND "currency" IS NOT NULL)
    ),
    -- Posterior al mantenimiento y a 10 años como mucho (la API da el 400).
    CONSTRAINT "equipment_maintenances_next_due_check" CHECK (
      "nextDueOn" IS NULL
      OR ("nextDueOn" > "performedOn"
          AND "nextDueOn" <= ("performedOn" + interval '10 years')::date)
    ),
    -- ANULADO <=> fecha, autor y motivo (como patient_implants_void_check).
    CONSTRAINT "equipment_maintenances_void_check" CHECK (
      ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
      OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL
          AND "voidReason" IS NOT NULL
          AND char_length(btrim("voidReason")) BETWEEN 3 AND 500)
    )
);

-- Hoja de vida en orden cronológico; también el último preventivo vivo de
-- cada equipo de una página de la lista. Es el lado hijo de la FK al equipo.
CREATE INDEX "equipment_maintenances_equipment_performed_idx"
  ON "equipment_maintenances"("tenantId", "equipmentId", "performedOn", "createdAt");
-- Lado hijo de las FK a currencies y users.
CREATE INDEX "equipment_maintenances_currency_idx" ON "equipment_maintenances"("currency");
CREATE INDEX "equipment_maintenances_created_by_idx" ON "equipment_maintenances"("createdById");
CREATE INDEX "equipment_maintenances_voided_by_idx" ON "equipment_maintenances"("voidedById");

-- Inmutabilidad. search_path fijo con pg_temp AL FINAL y catálogo calificado
-- (SEC-032). UPDATE: solo la anulación (void* de NULL a valor), una vez y sin
-- tocar ninguna otra columna. DELETE/TRUNCATE: solo un superusuario.
CREATE FUNCTION "dx_equipment_maintenances_immutable"() RETURNS trigger
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
    RAISE EXCEPTION 'equipment_maintenances es inalterable: no se permite % de un mantenimiento registrado; para corregirlo se anula con motivo (DX-542)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - void_columns)
       IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - void_columns)
     OR (OLD."voidedAt" IS NOT NULL AND (
           NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt"
           OR NEW."voidedById" IS DISTINCT FROM OLD."voidedById"
           OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason"))
  THEN
    RAISE EXCEPTION 'equipment_maintenances es inalterable: un mantenimiento registrado solo se anula, una vez (DX-542)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "equipment_maintenances_immutable"
  BEFORE UPDATE OR DELETE ON "equipment_maintenances"
  FOR EACH ROW EXECUTE FUNCTION "dx_equipment_maintenances_immutable"();
CREATE TRIGGER "equipment_maintenances_no_truncate"
  BEFORE TRUNCATE ON "equipment_maintenances"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_equipment_maintenances_immutable"();
-- La fecha de grabación la pone el servidor (función de DX-038).
CREATE TRIGGER "equipment_maintenances_server_timestamp"
  BEFORE INSERT ON "equipment_maintenances"
  FOR EACH ROW EXECUTE FUNCTION "dx_clinical_record_server_timestamp"();

ALTER TABLE "equipment_maintenances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "equipment_maintenances" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "equipment_maintenances"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Los mantenimientos nunca se borran (además del trigger).
REVOKE DELETE, TRUNCATE ON "equipment_maintenances" FROM dentalix_app;
GRANT SELECT, INSERT, UPDATE ON "equipment_maintenances" TO dentalix_app;
