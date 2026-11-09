-- DX-417: aceptación PARCIAL del presupuesto en la clínica. Al firmar solo
-- algunos procedimientos, el plan original queda ACCEPTED con los aceptados y
-- los demás se MUEVEN (mismo id, UPDATE de "planId") a un plan nuevo
-- PRESENTED, enlazado al original:
--
--   treatment_plans."splitFromPlanId"             UUID NULL   el plan cuya
--                                                             aceptación
--                                                             parcial dejó
--                                                             este pendiente;
--                                                             se escribe al
--                                                             crearlo y no
--                                                             cambia nunca
--   treatment_plan_acceptances."pendingPlanId"    UUID NULL   el plan pendiente
--   treatment_plan_acceptances."pendingItemIds"   UUID[] NULL los ítems que se
--                                                             dejaron fuera
--                                                             (prueba, aunque
--                                                             luego se edite
--                                                             el pendiente)
--   treatment_plan_acceptances."pendingTotal"     NUMERIC(14,2) NULL  su total
--                                                             al firmar, en la
--                                                             moneda del plan
--
-- Las columnas de la aceptación van FUERA del contenido firmado y de sus
-- hashes (como `clinicLogoKey` y las de DX-379 C): el contenido sellado es el
-- del subconjunto aceptado. Las tres juntas o ninguna (CHECK). El trigger
-- `treatment_plan_acceptances_immutable` ya rechaza todo UPDATE.
--
-- FK COMPUESTAS (SEC-004) a treatment_plans(tenantId, id, patientId): el
-- pendiente es de la MISMA clínica y del MISMO paciente. NO ACTION (no
-- RESTRICT), como la del grupo de opciones: un DELETE que se lleva todos los
-- planes de una vez (limpieza de tests) pasa; los planes se retiran en blando.
-- Un plan se acepta una sola vez, así que tiene como mucho un pendiente:
-- índices ÚNICOS parciales, que además son el lado hijo de cada FK (el RI
-- check del VALIDATE y de un DELETE del padre no recorren la tabla).
--
-- Escritura única de "splitFromPlanId": trigger BEFORE UPDATE OF que rechaza
-- cambiarla (también ponerla a NULL o ponérsela a un plan que no la tenía).
--
-- `treatment_plan_items_locked_when_accepted` se REEMPLAZA (versión vigente:
-- 20261020230300_dx105_plan_item_pricing_snapshot) para mirar también el plan
-- de ORIGEN al cambiar "planId": hasta ahora solo miraba el de destino, así
-- que sacar un ítem de un plan ya firmado no lo paraba la base. El resto de la
-- función no cambia. La aceptación parcial mueve los ítems ANTES de insertar
-- la aceptación del original, así que el trigger no la estorba.
--
-- CHECK y FK NOT VALID aquí (las filas existentes tienen todo a NULL) y
-- VALIDATE aparte (20261207090100_dx417_partial_acceptance_validate), como
-- DX-379 (C). Columnas NULL sin default (PG 16 solo toca el catálogo); una
-- réplica anterior inserta sin nombrarlas y recibe NULL, que cumple los CHECK.
-- Los índices se crean vacíos de entradas, pero CREATE INDEX lee la tabla una
-- vez con SHARE (no bloquea lecturas; las escrituras esperan lo que tarde).
-- Las columnas heredan el grant de la tabla a dentalix_app y su RLS.
--
-- Vuelta atrás (solo si hay que retirar esta porción):
--   1. Primero se despliega la versión anterior de la API (no lee ni escribe
--      estas columnas).
--   2. Después, en una transacción con el mismo lock_timeout:
--        DROP TRIGGER "treatment_plans_split_from_immutable" ON "treatment_plans";
--        DROP FUNCTION public."treatment_plans_split_from_immutable"();
--        ALTER TABLE "treatment_plan_acceptances"
--          DROP CONSTRAINT "treatment_plan_acceptances_pending_plan_fkey",
--          DROP CONSTRAINT "treatment_plan_acceptances_pending_check",
--          DROP COLUMN "pendingTotal", DROP COLUMN "pendingItemIds",
--          DROP COLUMN "pendingPlanId";
--        ALTER TABLE "treatment_plans"
--          DROP CONSTRAINT "treatment_plans_split_from_fkey",
--          DROP CONSTRAINT "treatment_plans_split_from_check",
--          DROP COLUMN "splitFromPlanId";
--      (los índices caen con sus columnas) y se vuelve a crear la función
--      `treatment_plan_items_locked_when_accepted` tal como la deja
--      20261020230300_dx105_plan_item_pricing_snapshot. Se borran de
--      `_prisma_migrations` las filas de esta migración y de su VALIDATE
--      (`npx prisma migrate resolve --rolled-back <nombre>`).
--   Se PIERDE el enlace entre cada plan aceptado en parte y su pendiente, y
--   qué ítems se dejaron fuera y por cuánto; los dos planes, sus ítems y la
--   aceptación (contenido firmado y hashes) no cambian.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plans"
  ADD COLUMN "splitFromPlanId" UUID,
  -- Un plan no es pendiente de sí mismo.
  ADD CONSTRAINT "treatment_plans_split_from_check" CHECK (
    "splitFromPlanId" IS DISTINCT FROM "id"
  ) NOT VALID,
  ADD CONSTRAINT "treatment_plans_split_from_fkey"
    FOREIGN KEY ("tenantId", "splitFromPlanId", "patientId")
    REFERENCES "treatment_plans"("tenantId", "id", "patientId")
    ON DELETE NO ACTION ON UPDATE NO ACTION
    NOT VALID;

CREATE UNIQUE INDEX "treatment_plans_split_from_key"
  ON "treatment_plans"("tenantId", "splitFromPlanId")
  WHERE "splitFromPlanId" IS NOT NULL;

ALTER TABLE "treatment_plan_acceptances"
  ADD COLUMN "pendingPlanId" UUID,
  ADD COLUMN "pendingItemIds" UUID[],
  ADD COLUMN "pendingTotal" NUMERIC(14, 2),
  -- Las tres o ninguna; al menos un ítem pendiente, sin NULL dentro; total no
  -- negativo; el pendiente no es el plan aceptado.
  ADD CONSTRAINT "treatment_plan_acceptances_pending_check" CHECK (
    (
      "pendingPlanId" IS NULL
      AND "pendingItemIds" IS NULL
      AND "pendingTotal" IS NULL
    )
    OR (
      "pendingPlanId" IS NOT NULL
      AND "pendingPlanId" <> "planId"
      AND "pendingItemIds" IS NOT NULL
      AND cardinality("pendingItemIds") >= 1
      AND array_position("pendingItemIds", NULL) IS NULL
      AND "pendingTotal" IS NOT NULL
      AND "pendingTotal" >= 0
    )
  ) NOT VALID,
  ADD CONSTRAINT "treatment_plan_acceptances_pending_plan_fkey"
    FOREIGN KEY ("tenantId", "pendingPlanId", "patientId")
    REFERENCES "treatment_plans"("tenantId", "id", "patientId")
    ON DELETE NO ACTION ON UPDATE NO ACTION
    NOT VALID;

CREATE UNIQUE INDEX "treatment_plan_acceptances_pending_plan_key"
  ON "treatment_plan_acceptances"("tenantId", "pendingPlanId")
  WHERE "pendingPlanId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- El enlace del pendiente con su original se escribe al crearlo y no cambia.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public."treatment_plans_split_from_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."splitFromPlanId" IS DISTINCT FROM OLD."splitFromPlanId" THEN
    RAISE EXCEPTION 'el enlace del presupuesto pendiente con su plan original no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "treatment_plans_split_from_immutable"
  BEFORE UPDATE OF "splitFromPlanId" ON "treatment_plans"
  FOR EACH ROW EXECUTE FUNCTION public."treatment_plans_split_from_immutable"();

-- ---------------------------------------------------------------------------
-- Bloqueos: versión vigente (20261020230300_dx105_plan_item_pricing_snapshot)
-- más el plan de ORIGEN al cambiar "planId".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."treatment_plan_items_locked_when_accepted"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  plan_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."planId" ELSE NEW."planId" END;
BEGIN
  -- DX-417: un ítem tampoco SALE de un plan firmado hacia otro plan.
  IF TG_OP = 'UPDATE' AND NEW."planId" IS DISTINCT FROM OLD."planId" THEN
    PERFORM 1 FROM public."treatment_plans" WHERE "id" = OLD."planId" FOR SHARE;
    IF EXISTS (SELECT 1 FROM public."treatment_plan_acceptances" WHERE "planId" = OLD."planId") THEN
      RAISE EXCEPTION 'el plan está aceptado y firmado: sus ítems no pasan a otro plan'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
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
     OR NEW."basePrice" IS DISTINCT FROM OLD."basePrice"
     OR NEW."priceSource" IS DISTINCT FROM OLD."priceSource"
     OR NEW."agreementId" IS DISTINCT FROM OLD."agreementId"
     OR NEW."agreementName" IS DISTINCT FROM OLD."agreementName"
     OR NEW."pricingLocationId" IS DISTINCT FROM OLD."pricingLocationId"
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
