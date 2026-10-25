-- SEC-050: el cargo por inasistencia de un plan ya COMPLETADO no se podía
-- anular. SEC-050 deja completar el plan «Cargos administrativos» (no deja de
-- cobrarse), pero la anulación retira su ítem y el trigger de DX-109
-- (`treatment_plan_items_locked_when_closed`) rechaza retirar ítems de un
-- plan cerrado: `POST …/cancellation-fee/void` respondía 409 genérico y el
-- cargo quedaba sin forma de anularse.
--
-- Una excepción más, acotada, en ese trigger: en un plan cerrado sí se retira
-- (solo `deletedAt`, sin tocar nada más de la fila) el ítem de un cargo que YA
-- está anulado en `cancellation_fees` (con autor y motivo; la anulación va
-- antes, en la misma transacción). El resto del trigger es el de DX-050
-- (`20261023160000_dx050_plan_item_attribution`), sin cambios.
--
-- Aditiva: solo reemplaza la función (catálogo, sin candado sobre las tablas).

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public."treatment_plan_items_locked_when_closed"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  plan_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."planId" ELSE NEW."planId" END;
  plan_status text;
  attribution text[] := ARRAY['performedById', 'performedByMembershipId',
                              'performedLocationId', 'completedAt', 'updatedAt'];
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
       AND NEW."basePrice" IS NOT DISTINCT FROM OLD."basePrice"
       AND NEW."priceSource" IS NOT DISTINCT FROM OLD."priceSource"
       AND NEW."agreementId" IS NOT DISTINCT FROM OLD."agreementId"
       AND NEW."agreementName" IS NOT DISTINCT FROM OLD."agreementName"
       AND NEW."pricingLocationId" IS NOT DISTINCT FROM OLD."pricingLocationId"
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
    -- SEC-050: retirar el ítem de un cargo por inasistencia ya anulado.
    IF TG_OP = 'UPDATE'
       AND OLD."deletedAt" IS NULL
       AND NEW."deletedAt" IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['deletedAt', 'updatedAt'])
           = (to_jsonb(OLD) - ARRAY['deletedAt', 'updatedAt'])
       AND EXISTS (
         SELECT 1
           FROM public."cancellation_fees" f
          WHERE f."tenantId" = OLD."tenantId"
            AND f."patientId" = OLD."patientId"
            AND f."planItemId" = OLD."id"
            AND f."status" = 'CHARGED'
            AND f."voidedAt" IS NOT NULL
       ) THEN
      RETURN NEW;
    END IF;
    -- DX-050: corregir quién o cuándo de un ítem ya REALIZADO.
    IF TG_OP = 'UPDATE'
       AND OLD."status"::text = 'DONE'
       AND NEW."status"::text = 'DONE'
       AND (to_jsonb(NEW) - attribution) = (to_jsonb(OLD) - attribution) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'el plan está cerrado: sus ítems no se añaden, cambian ni retiran'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
