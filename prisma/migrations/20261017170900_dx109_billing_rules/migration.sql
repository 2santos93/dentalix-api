-- DX-109 · Reglas de cobro. Todo aditivo: no se borra ni reescribe ningún dato
-- (los abonos ya registrados sobre planes rechazados siguen ahí y en `paid`).

-- BE-017: huella de la petición de cada Idempotency-Key (SHA-256 hex del plan
-- + cuerpo normalizado). NULL en las filas anteriores: se siguen reconociendo.
ALTER TABLE "payments" ADD COLUMN "idempotencyFingerprint" TEXT;

-- Cancelación del plan de cuotas (motivo y autor). Puntero suave a users,
-- como "createdById".
ALTER TABLE "payment_plans"
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledById" UUID,
  ADD COLUMN "cancelReason" TEXT;

-- BE-002: los ítems de un plan CERRADO (cancelado, rechazado o completado) no
-- se añaden, cambian ni retiran. La aplicación responde 409 antes; esto es la
-- red. Sin `app.current_tenant` (mantenimiento con el rol propietario) no
-- aplica, igual que el borrado de `treatment_plan_items_locked_when_accepted`.
-- Bloquea el plan FOR SHARE (orden plan → ítem, DX-012): un cierre concurrente
-- espera o es esperado, nunca se cruzan.
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
    RAISE EXCEPTION 'el plan está cerrado: sus ítems no se añaden, cambian ni retiran'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "treatment_plan_items_locked_when_closed"
  BEFORE INSERT OR UPDATE OR DELETE ON "treatment_plan_items"
  FOR EACH ROW EXECUTE FUNCTION public."treatment_plan_items_locked_when_closed"();
