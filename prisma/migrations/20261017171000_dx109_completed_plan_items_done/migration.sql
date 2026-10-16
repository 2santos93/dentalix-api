-- DX-109 (revisión) · Un plan COMPLETED admite UNA escritura de ítems: marcar
-- como realizado (ACCEPTED → DONE) un procedimiento que quedó aceptado, sin
-- tocar nada más. COMPLETED es final y la máquina de estados no exige que todo
-- esté hecho para completarlo: sin esta excepción, ese procedimiento no
-- llegaría nunca a «Realizado» ni al odontograma. No cambia el cobro (ACCEPTED
-- y DONE facturan igual). Misma regla que `isClosedPlanItemChangeAllowed`
-- (aplicación). Solo reemplaza la función: el trigger sigue igual.
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
