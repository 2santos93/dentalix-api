-- SEC-041: el tope de descuento por rol (DX-204) también cubre la rebaja del
-- precio frente al de catálogo.
--
-- Cambios:
--   treatment_plan_items   columna NULL "catalogPrice": el precio de catálogo
--                          al dar de alta el ítem (NULL = ítem libre). La API
--                          cuenta como descuento max(0, catalogPrice − price)
--                          + discount y firma la rebaja con las columnas del
--                          descuento de DX-204 (quién, cuándo, sede, motivo).
--                          Backfill desde el catálogo: el defaultPrice ACTUAL
--                          del ítem de catálogo (no hay histórico de precios).
--   triggers de bloqueo    un plan firmado (DX-012) o cerrado (DX-109) tampoco
--                          cambia "catalogPrice".
--   índice del informe     el parcial del informe de descuentos (DX-204) pasa
--                          a cubrir también los ítems con el precio rebajado.
--
-- Compatible hacia atrás: solo AÑADE una columna NULL y un CHECK que las filas
-- cumplen; el índice parcial se sustituye por otro con un predicado más
-- amplio (no hay datos que perder); las dos funciones de trigger se
-- reemplazan con las mismas reglas más la columna nueva.
--
-- Backfill con un owner sin superusuario (DX-113): con RLS FORCE el owner no
-- vería filas y el UPDATE "pasaría" sin hacer nada, así que FORCE se quita
-- durante el relleno de las dos tablas que lee y escribe y se repone al final.
-- Se rellena ANTES de reemplazar los triggers: la versión vigente de
-- `treatment_plan_items_locked_when_accepted` no mira "catalogPrice" (los
-- ítems de planes firmados también lo reciben) y la de `_when_closed` no actúa
-- sin `app.current_tenant`. El trigger de cartera (DX-155) solo recalcula si
-- cambian precio, descuento, estado o retiro: aquí no.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plan_items" ADD COLUMN "catalogPrice" DECIMAL(12,2);

ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_catalog_price_nonneg"
  CHECK ("catalogPrice" IS NULL OR "catalogPrice" >= 0) NOT VALID;
ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_catalog_price_nonneg";

-- ---------------------------------------------------------------------------
-- Backfill desde el catálogo (misma clínica: unión por tenantId + id)
-- ---------------------------------------------------------------------------
ALTER TABLE "treatment_plan_items" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "dental_catalog_items" NO FORCE ROW LEVEL SECURITY;

UPDATE "treatment_plan_items" i
   SET "catalogPrice" = c."defaultPrice"
  FROM "dental_catalog_items" c
 WHERE c."tenantId" = i."tenantId"
   AND c."id" = i."catalogItemId"
   AND c."defaultPrice" IS NOT NULL
   AND i."catalogPrice" IS NULL;

ALTER TABLE "dental_catalog_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_items" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Informe de descuentos (DX-204 + SEC-041): ítems vivos con descuento o con
-- el precio por debajo del de catálogo, por fecha del descuento (o de alta).
-- PARCIAL y de expresión: no declarable en Prisma (ver schema.prisma). El
-- predicado es el mismo texto que usa la consulta del informe.
-- ---------------------------------------------------------------------------
CREATE INDEX "treatment_plan_items_tenant_effective_discount_at_idx"
  ON "treatment_plan_items"("tenantId", (COALESCE("discountAt", "createdAt")))
  WHERE ("discount" > 0 OR "price" < "catalogPrice") AND "deletedAt" IS NULL;
DROP INDEX IF EXISTS "treatment_plan_items_tenant_discounted_at_idx";

-- ---------------------------------------------------------------------------
-- Bloqueos: versión vigente (20261018090100_dx204_discount_policy) más
-- "catalogPrice".
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
     OR NEW."catalogPrice" IS DISTINCT FROM OLD."catalogPrice"
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
       AND NEW."catalogPrice" IS NOT DISTINCT FROM OLD."catalogPrice"
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
