-- DX-204: tope de descuento por rol, motivo obligatorio e informe de descuentos.
--
-- Cambios:
--   discount_policies      política de descuentos de la clínica (una fila por
--                          tenant): % máximo por rol (enteros 0..100) y umbral
--                          a partir del cual el motivo es obligatorio. Sin fila,
--                          la API aplica los valores por defecto (ADMIN 100,
--                          DENTIST 10, el resto 0; motivo por encima del 10 %).
--   treatment_plan_items   quién dio el descuento, cuándo (hora del servidor),
--                          en qué sede y por qué (catálogo corto + nota). Las
--                          filas anteriores quedan con NULL: el informe las
--                          fecha por su creación y su sede por la de
--                          presentación del plan (sin backfill: con RLS FORCE
--                          el owner no ve filas, y los ítems de un plan firmado
--                          no admiten UPDATE).
--   triggers de bloqueo    los ítems de un plan firmado (DX-012) o cerrado
--                          (DX-109) tampoco cambian el motivo ni el autor del
--                          descuento.
--   audit_events           índice parcial de DISCOUNT_POLICY (DX-102).
--
-- FK COMPUESTA por tenant (SEC-004): la sede del descuento es de la MISMA
-- clínica. Las FK sobre treatment_plan_items (RLS FORCE) siguen la regla de
-- DX-134: NO FORCE en la hija y en la referenciada durante la migración y FORCE
-- al final; NOT VALID + VALIDATE (DB-025). La FK de la tabla nueva va dentro de
-- su CREATE TABLE (nace vacía).
--
-- Compatible hacia atrás: solo AÑADE (un enum, una tabla vacía, columnas NULL
-- sin default, índices, CHECKs que las filas existentes cumplen) y reemplaza
-- dos funciones de trigger con las mismas reglas más las columnas nuevas.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "DiscountReason" AS ENUM (
  'LOYALTY',
  'FAMILY_OR_STAFF',
  'PROMOTION',
  'FINANCIAL_HARDSHIP',
  'SERVICE_RECOVERY',
  'OTHER'
);

-- ---------------------------------------------------------------------------
-- discount_policies
-- ---------------------------------------------------------------------------
CREATE TABLE "discount_policies" (
    "tenantId" UUID NOT NULL,
    "adminMaxPercent" INTEGER NOT NULL DEFAULT 100,
    "dentistMaxPercent" INTEGER NOT NULL DEFAULT 10,
    "assistantMaxPercent" INTEGER NOT NULL DEFAULT 0,
    "receptionMaxPercent" INTEGER NOT NULL DEFAULT 0,
    "reasonRequiredAbovePercent" INTEGER NOT NULL DEFAULT 10,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discount_policies_pkey" PRIMARY KEY ("tenantId"),
    CONSTRAINT "discount_policies_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "discount_policies_updatedById_fkey"
      FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Mismos límites que la API (400 en español antes); esto es la red.
    CONSTRAINT "discount_policies_percent_check" CHECK (
      "adminMaxPercent" BETWEEN 0 AND 100
      AND "dentistMaxPercent" BETWEEN 0 AND 100
      AND "assistantMaxPercent" BETWEEN 0 AND 100
      AND "receptionMaxPercent" BETWEEN 0 AND 100
      AND "reasonRequiredAbovePercent" BETWEEN 0 AND 100
    )
);

-- Lado hijo de la FK al usuario que la cambió.
CREATE INDEX "discount_policies_updatedById_idx" ON "discount_policies"("updatedById");

ALTER TABLE "discount_policies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "discount_policies"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "discount_policies" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- treatment_plan_items: autor, hora, sede y motivo del descuento
-- ---------------------------------------------------------------------------
ALTER TABLE "treatment_plan_items" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "treatment_plan_items"
  ADD COLUMN "discountReason" "DiscountReason",
  ADD COLUMN "discountReasonNote" TEXT,
  ADD COLUMN "discountById" UUID,
  ADD COLUMN "discountAt" TIMESTAMP(3),
  ADD COLUMN "discountLocationId" UUID;

ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_discount_by_fkey"
  FOREIGN KEY ("discountById") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_discount_by_fkey";

ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_discount_location_fkey"
  FOREIGN KEY ("tenantId", "discountLocationId") REFERENCES "locations"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_discount_location_fkey";

-- La nota del motivo: corta y no vacía; «Otro» la exige. Sin motivo no hay nota.
ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_discount_reason_check"
  CHECK (
    ("discountReasonNote" IS NULL OR char_length(btrim("discountReasonNote")) BETWEEN 1 AND 200)
    AND ("discountReasonNote" IS NULL OR "discountReason" IS NOT NULL)
    AND ("discountReason" IS DISTINCT FROM 'OTHER' OR "discountReasonNote" IS NOT NULL)
  ) NOT VALID;
ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_discount_reason_check";

ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_items" FORCE ROW LEVEL SECURITY;

-- Lados hijos de las FK nuevas.
CREATE INDEX "treatment_plan_items_tenantId_discountLocationId_idx"
  ON "treatment_plan_items"("tenantId", "discountLocationId");
CREATE INDEX "treatment_plan_items_discountById_idx"
  ON "treatment_plan_items"("discountById");
-- Informe de descuentos (DX-204): ítems vivos con descuento de la clínica por
-- fecha del descuento (o de creación, en los anteriores a DX-204). PARCIAL y
-- de expresión: no declarable en Prisma (ver schema.prisma).
CREATE INDEX "treatment_plan_items_tenant_discounted_at_idx"
  ON "treatment_plan_items"("tenantId", (COALESCE("discountAt", "createdAt")))
  WHERE "discount" > 0 AND "deletedAt" IS NULL;

-- ---------------------------------------------------------------------------
-- Bloqueos: versión vigente (20261017160000_function_search_path) más las
-- columnas del descuento.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."treatment_plan_items_locked_when_accepted"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  plan_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."planId" ELSE NEW."planId" END;
BEGIN
  PERFORM 1 FROM public."treatment_plans" WHERE "id" = plan_id FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM public."treatment_plan_acceptances" WHERE "planId" = plan_id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'el plan está aceptado y firmado: no admite ítems nuevos'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
      RAISE EXCEPTION 'el plan está aceptado y firmado: sus ítems no se borran'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."planId" IS DISTINCT FROM OLD."planId"
     OR NEW."toothNumber" IS DISTINCT FROM OLD."toothNumber"
     OR NEW."surfaces" IS DISTINCT FROM OLD."surfaces"
     OR NEW."catalogItemId" IS DISTINCT FROM OLD."catalogItemId"
     OR NEW."price" IS DISTINCT FROM OLD."price"
     OR NEW."discount" IS DISTINCT FROM OLD."discount"
     OR NEW."discountReason" IS DISTINCT FROM OLD."discountReason"
     OR NEW."discountReasonNote" IS DISTINCT FROM OLD."discountReasonNote"
     OR NEW."discountById" IS DISTINCT FROM OLD."discountById"
     OR NEW."discountAt" IS DISTINCT FROM OLD."discountAt"
     OR NEW."discountLocationId" IS DISTINCT FROM OLD."discountLocationId"
     OR NEW."notes" IS DISTINCT FROM OLD."notes"
     OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt"
     OR (NEW."status" = 'PROPOSED' AND OLD."status" <> 'PROPOSED') THEN
    RAISE EXCEPTION 'el plan está aceptado y firmado: sus ítems no se modifican'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Versión vigente: 20261017171000_dx109_completed_plan_items_done.
CREATE OR REPLACE FUNCTION public."treatment_plan_items_locked_when_closed"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  plan_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."planId" ELSE NEW."planId" END;
  plan_status text;
BEGIN
  IF coalesce(current_setting('app.current_tenant', true), '') = '' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT p."status"::text INTO plan_status
    FROM public."treatment_plans" p WHERE p."id" = plan_id FOR SHARE;
  IF plan_status IN ('CANCELLED', 'REJECTED', 'COMPLETED') THEN
    IF TG_OP = 'UPDATE'
       AND plan_status = 'COMPLETED'
       AND OLD."status"::text = 'ACCEPTED'
       AND NEW."status"::text = 'DONE'
       AND NEW."planId" IS NOT DISTINCT FROM OLD."planId"
       AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
       AND NEW."toothNumber" IS NOT DISTINCT FROM OLD."toothNumber"
       AND NEW."surfaces" IS NOT DISTINCT FROM OLD."surfaces"
       AND NEW."catalogItemId" IS NOT DISTINCT FROM OLD."catalogItemId"
       AND NEW."price" IS NOT DISTINCT FROM OLD."price"
       AND NEW."discount" IS NOT DISTINCT FROM OLD."discount"
       AND NEW."discountReason" IS NOT DISTINCT FROM OLD."discountReason"
       AND NEW."discountReasonNote" IS NOT DISTINCT FROM OLD."discountReasonNote"
       AND NEW."discountById" IS NOT DISTINCT FROM OLD."discountById"
       AND NEW."discountAt" IS NOT DISTINCT FROM OLD."discountAt"
       AND NEW."discountLocationId" IS NOT DISTINCT FROM OLD."discountLocationId"
       AND NEW."notes" IS NOT DISTINCT FROM OLD."notes"
       AND NEW."deletedAt" IS NOT DISTINCT FROM OLD."deletedAt" THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'el plan está cerrado: sus ítems no se añaden, cambian ni retiran'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- ---------------------------------------------------------------------------
-- audit_events: índice parcial de DISCOUNT_POLICY (DX-102: uno por valor)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "audit_events_resource_discount_policy_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'DISCOUNT_POLICY';
