-- DX-091 (revisión de seguridad, MEDIUM): el cierre contable también en la BD
-- para los planes de cuotas, y la guarda de `payments` sin huecos.
--
-- Hallazgo: `cancelActivePaymentPlans` (aceptar otra opción del grupo,
-- cancelar o rechazar el plan de tratamiento) cancelaba planes de cuotas
-- ACTIVOS con `updateMany` sin pasar por el cierre: anulaba cuotas vencidas
-- antes del cierre. La app ya lo frena (409 PERIOD_LOCKED); esto es la red
-- para cualquier camino que olvide la regla, como hace
-- payments_financial_lock_guard con los abonos.
--
-- Cambios (solo funciones y triggers; ninguna columna, índice ni dato):
--   dx_payment_plan_locked_through(t, plan)
--                         el último día cerrado para un plan de cuotas, con
--                         «hoy» en la zona de su sede (la de su plan de
--                         tratamiento: aceptación, si no presentación, si no
--                         la sede principal, como paymentPlanLocationId +
--                         loadTenantZones). NULL sin cierre; 'infinity' si la
--                         sede no tiene zona (con cierre configurado no se
--                         puede medir: todo cuenta como cerrado, igual que
--                         en payments).
--   payment_plans_financial_lock_guard  BEFORE UPDATE: un plan de cuotas con
--                         alguna cuota en un día cerrado no deja de estar
--                         vigente (cancelar, borrar en blando), no vuelve a
--                         estarlo y no cambia su cabecera de dinero.
--   installments_financial_lock_guard   BEFORE INSERT | UPDATE | DELETE: una
--                         cuota con vencimiento en un día cerrado no nace (no
--                         se antedatan cuotas), no cambia y no se borra; una
--                         cuota no se mueve a un día cerrado.
--   dx_payments_financial_lock_guard()  (mismo nombre, cuerpo nuevo) y su
--                         trigger pasa de INSERT | UPDATE OF "deletedAt" a
--                         INSERT | UPDATE | DELETE: además de nacer y anularse,
--                         un abono vigente de un día cerrado no cambia sus
--                         columnas de dinero (importe, moneda, día, sede,
--                         medio, caja, marca de anulado), no se mueve a un día
--                         cerrado ni se borra en duro.
--
-- Quién pasa (igual en los tres):
--   - la excepción del ADMIN registrada por la app: el GUC local
--     dentalix.financial_lock_override con el id del abono o del plan de
--     cuotas, en la transacción que escribe financial_lock_overrides;
--   - la fusión de pacientes (dx_patient_merge_gate, compuerta común): solo
--     cambia el paciente, y además ninguna de las columnas vigiladas;
--   - el superusuario (fixtures, purgas, réplica), como el resto de guardas
--     financieras.
-- SQLSTATE Q0910 → 409 PERIOD_LOCKED en el filtro global.
--
-- Compatible hacia atrás: con la clínica sin cierre nada cambia. Rollback:
--   DROP TRIGGER installments_financial_lock_guard ON installments;
--   DROP TRIGGER payment_plans_financial_lock_guard ON payment_plans;
--   DROP FUNCTION public.dx_installments_financial_lock_guard();
--   DROP FUNCTION public.dx_payment_plans_financial_lock_guard();
--   DROP FUNCTION public.dx_payment_plan_locked_through(uuid, uuid);
--   y restaurar dx_payments_financial_lock_guard y su trigger de
--   20261231090000.
--
-- Bloqueos: CREATE/DROP TRIGGER toman SHARE ROW EXCLUSIVE (frenan escrituras,
-- no lecturas); lock_timeout acota la espera. search_path fijo con pg_temp al
-- final y catálogo calificado (SEC-032). Sin datos personales en mensajes.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. El cierre de un plan de cuotas
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_payment_plan_locked_through(p_tenant uuid, p_payment_plan uuid)
  RETURNS date
  LANGUAGE plpgsql
  STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_configured boolean;
  v_location uuid;
  v_zone text;
BEGIN
  SELECT (t."financialLockDate" IS NOT NULL OR t."financialLockDays" IS NOT NULL)
    INTO v_configured
    FROM public.tenants t
   WHERE t."id" = p_tenant;
  IF NOT COALESCE(v_configured, false) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(tp."acceptedLocationId", tp."presentedLocationId")
    INTO v_location
    FROM public.payment_plans pp
    JOIN public.treatment_plans tp
      ON tp."tenantId" = pp."tenantId" AND tp."id" = pp."treatmentPlanId"
   WHERE pp."tenantId" = p_tenant AND pp."id" = p_payment_plan;
  IF v_location IS NULL THEN
    -- La sede principal (R6): la activa más antigua.
    SELECT l."id" INTO v_location
      FROM public.locations l
     WHERE l."tenantId" = p_tenant AND l."deletedAt" IS NULL AND l."isActive"
     ORDER BY l."createdAt", l."id"
     LIMIT 1;
  END IF;
  SELECT l."timeZone" INTO v_zone
    FROM public.locations l
   WHERE l."tenantId" = p_tenant AND l."id" = v_location;
  IF v_zone IS NULL THEN
    RETURN 'infinity'::date;
  END IF;
  RETURN public.dx_financial_locked_through(p_tenant, v_zone);
END;
$$;

-- ¿Abre la app la excepción para este abono o plan de cuotas?
CREATE FUNCTION public.dx_financial_lock_override_has(p_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_id::text = ANY (pg_catalog.string_to_array(
    COALESCE(pg_catalog.current_setting('dentalix.financial_lock_override', true), ''),
    ','))
$$;

-- ---------------------------------------------------------------------------
-- 2. payment_plans
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_payment_plans_financial_lock_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_through date;
BEGIN
  -- Solo importa si cambia su vigencia o su cabecera de dinero.
  IF ((OLD."status" = 'ACTIVE' AND OLD."deletedAt" IS NULL)
        IS NOT DISTINCT FROM (NEW."status" = 'ACTIVE' AND NEW."deletedAt" IS NULL))
     AND (NEW."tenantId", NEW."treatmentPlanId", NEW."currency", NEW."totalToFinance",
          NEW."downPayment", NEW."installmentsCount", NEW."periodicity", NEW."startDate")
         IS NOT DISTINCT FROM
         (OLD."tenantId", OLD."treatmentPlanId", OLD."currency", OLD."totalToFinance",
          OLD."downPayment", OLD."installmentsCount", OLD."periodicity", OLD."startDate")
  THEN
    RETURN NEW;
  END IF;

  IF public.dx_patient_merge_active()
     AND public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF public.dx_cash_is_superuser() THEN
    RETURN NEW;
  END IF;
  IF public.dx_financial_lock_override_has(OLD."id") THEN
    RETURN NEW;
  END IF;

  v_through := public.dx_payment_plan_locked_through(OLD."tenantId", OLD."id");
  IF v_through IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.installments i
     WHERE i."tenantId" = OLD."tenantId"
       AND i."paymentPlanId" = OLD."id"
       AND (i."dueDate")::date <= v_through
  ) THEN
    RAISE EXCEPTION 'El plan de cuotas tiene cuotas en un período contable cerrado (DX-091)'
      USING ERRCODE = 'Q0910';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_plans_financial_lock_guard"
  BEFORE UPDATE ON "payment_plans"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payment_plans_financial_lock_guard();

-- ---------------------------------------------------------------------------
-- 3. installments
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_installments_financial_lock_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_through date;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (pg_catalog.to_jsonb(NEW) OPERATOR(pg_catalog.-) 'updatedAt'::text)
         IS NOT DISTINCT FROM
         (pg_catalog.to_jsonb(OLD) OPERATOR(pg_catalog.-) 'updatedAt'::text) THEN
    RETURN NEW;
  END IF;
  -- (installments no está en dx_patient_merge_tables: la fusión no la toca.)
  IF public.dx_cash_is_superuser() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- La cuota tal como estaba (cambiar o borrar).
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND NOT public.dx_financial_lock_override_has(OLD."paymentPlanId") THEN
    v_through := public.dx_payment_plan_locked_through(OLD."tenantId", OLD."paymentPlanId");
    IF v_through IS NOT NULL AND (OLD."dueDate")::date <= v_through THEN
      RAISE EXCEPTION 'La cuota vence en un período contable cerrado (DX-091)'
        USING ERRCODE = 'Q0910';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  -- La cuota tal como queda (nacer o moverse).
  IF NOT public.dx_financial_lock_override_has(NEW."paymentPlanId") THEN
    v_through := public.dx_payment_plan_locked_through(NEW."tenantId", NEW."paymentPlanId");
    IF v_through IS NOT NULL AND (NEW."dueDate")::date <= v_through THEN
      RAISE EXCEPTION 'La cuota vence en un período contable cerrado (DX-091)'
        USING ERRCODE = 'Q0910';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "installments_financial_lock_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "installments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_installments_financial_lock_guard();

-- ---------------------------------------------------------------------------
-- 4. payments: sin huecos (cambiar dinero o borrar en duro)
-- ---------------------------------------------------------------------------

-- ¿Cae en un día cerrado este abono (día civil de su sede)? Con cierre y sin
-- zona: sí (la app ya exige la zona antes, 409 LOCATION_TIMEZONE_REQUIRED).
CREATE FUNCTION public.dx_payment_day_locked(p_tenant uuid, p_location uuid, p_paid timestamp(3))
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_configured boolean;
  v_zone text;
  v_through date;
BEGIN
  SELECT (t."financialLockDate" IS NOT NULL OR t."financialLockDays" IS NOT NULL)
    INTO v_configured
    FROM public.tenants t
   WHERE t."id" = p_tenant;
  IF NOT COALESCE(v_configured, false) THEN
    RETURN false;
  END IF;
  SELECT l."timeZone" INTO v_zone
    FROM public.locations l
   WHERE l."tenantId" = p_tenant AND l."id" = p_location;
  IF v_zone IS NULL THEN
    RETURN true;
  END IF;
  v_through := public.dx_financial_locked_through(p_tenant, v_zone);
  RETURN v_through IS NOT NULL
     AND (pg_catalog.timezone(v_zone, pg_catalog.timezone('UTC', p_paid)))::date <= v_through;
END;
$$;

CREATE OR REPLACE FUNCTION public.dx_payments_financial_lock_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_check_old boolean := false;
  v_check_new boolean := false;
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- Un abono nace vigente (SEC-042 rechaza lo demás).
    v_check_new := NEW."deletedAt" IS NULL;
  ELSIF TG_OP = 'DELETE' THEN
    -- Un abono anulado no se borra (SEC-042); uno vigente, tampoco si es de
    -- un día cerrado.
    v_check_old := OLD."deletedAt" IS NULL;
  ELSIF OLD."deletedAt" IS NULL THEN
    IF NEW."deletedAt" IS NOT NULL THEN
      -- Anular: cuenta el día del abono tal como estaba.
      v_check_old := true;
    ELSIF (NEW."tenantId", NEW."locationId", NEW."amount", NEW."currency", NEW."paidAt",
           NEW."method", NEW."paymentMethodId", NEW."cashSessionId", NEW."voidedAt")
          IS DISTINCT FROM
          (OLD."tenantId", OLD."locationId", OLD."amount", OLD."currency", OLD."paidAt",
           OLD."method", OLD."paymentMethodId", OLD."cashSessionId", OLD."voidedAt") THEN
      -- Cambiar el dinero de un abono vigente: ni sacarlo de un día cerrado
      -- ni meterlo en uno.
      v_check_old := true;
      v_check_new := true;
    END IF;
  END IF;
  IF NOT (v_check_old OR v_check_new) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF public.dx_cash_is_superuser() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF v_check_old
     AND NOT public.dx_financial_lock_override_has(OLD."id")
     AND public.dx_payment_day_locked(OLD."tenantId", OLD."locationId", OLD."paidAt") THEN
    RAISE EXCEPTION 'El abono es de un período contable cerrado (DX-091)'
      USING ERRCODE = 'Q0910';
  END IF;
  IF v_check_new
     AND NOT public.dx_financial_lock_override_has(NEW."id")
     AND public.dx_payment_day_locked(NEW."tenantId", NEW."locationId", NEW."paidAt") THEN
    RAISE EXCEPTION 'El abono es de un período contable cerrado (DX-091)'
      USING ERRCODE = 'Q0910';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "payments_financial_lock_guard" ON "payments";
CREATE TRIGGER "payments_financial_lock_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payments_financial_lock_guard();
