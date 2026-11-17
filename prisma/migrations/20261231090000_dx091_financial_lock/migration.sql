-- DX-091: fecha de cierre contable para abonos y anulaciones.
--
-- Cambios:
--   tenants.financialLockDate         DATE NULL: cerrado ese día civil y lo
--                                     anterior.
--   tenants.financialLockDays         INT NULL (CHECK 0..365, NOT VALID y
--                                     validado en 20261231090100): días
--                                     abiertos hacia atrás; con N queda
--                                     cerrado todo lo anterior a hoy − N.
--   tenants.financialLockAdminExempt  BOOL (false): el ADMIN salta el cierre
--                                     con motivo.
--   "FinancialLockOperation"          PAYMENT_CREATE | PAYMENT_VOID |
--                                     PAYMENT_PLAN_CREATE | PAYMENT_PLAN_CANCEL.
--   financial_lock_overrides          registro append-only de cada excepción:
--                                     quién, cuándo (hora de la BD), por qué
--                                     (3..300), operación, abono o plan de
--                                     cuotas, día cerrado tocado y cierre
--                                     vigente. RLS FORCE, FK compuestas.
--   dx_financial_locked_through()     el último día cerrado de una clínica en
--                                     la zona de una sede (el más tardío de
--                                     los dos ajustes).
--   payments_financial_lock_guard     BEFORE INSERT y paso a anulado: un abono
--                                     con día civil (en la zona de su sede)
--                                     cerrado no nace ni se anula, salvo que
--                                     la transacción abra la excepción para
--                                     ESE abono (GUC local
--                                     dentalix.financial_lock_override con sus
--                                     ids) o sea el superusuario. SQLSTATE
--                                     propio Q0910 → 409 PERIOD_LOCKED.
--
-- Compatible hacia atrás: solo AÑADE (columnas NULL o con DEFAULT, una tabla
-- vacía, un trigger que no hace nada mientras la clínica no tenga cierre). Una
-- réplica anterior no conoce el cierre: si la clínica ya lo tiene, el trigger
-- le responde con el error de la BD (409 genérico), nunca con una escritura en
-- el período cerrado.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Ajustes en tenants
-- ---------------------------------------------------------------------------
ALTER TABLE "tenants" ADD COLUMN     "financialLockAdminExempt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "financialLockDate" DATE,
ADD COLUMN     "financialLockDays" INTEGER;

ALTER TABLE "tenants" ADD CONSTRAINT "tenants_financial_lock_days_check"
  CHECK ("financialLockDays" IS NULL OR "financialLockDays" BETWEEN 0 AND 365) NOT VALID;

-- ---------------------------------------------------------------------------
-- 2. Registro de excepciones (append-only)
-- ---------------------------------------------------------------------------
CREATE TYPE "FinancialLockOperation" AS ENUM ('PAYMENT_CREATE', 'PAYMENT_VOID', 'PAYMENT_PLAN_CREATE', 'PAYMENT_PLAN_CANCEL');

CREATE TABLE "financial_lock_overrides" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID,
    "operation" "FinancialLockOperation" NOT NULL,
    "paymentId" UUID,
    "paymentPlanId" UUID,
    "businessDate" DATE NOT NULL,
    "lockedThrough" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "actorUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_lock_overrides_pkey" PRIMARY KEY ("id"),
    -- La API responde 400 en español antes; esto es la red.
    CONSTRAINT "financial_lock_overrides_reason_check" CHECK (
      length("reason") BETWEEN 3 AND 300 AND "reason" = btrim("reason")
    ),
    CONSTRAINT "financial_lock_overrides_target_check" CHECK (
      ("operation" IN ('PAYMENT_CREATE', 'PAYMENT_VOID')
        AND "paymentId" IS NOT NULL AND "paymentPlanId" IS NULL)
      OR ("operation" IN ('PAYMENT_PLAN_CREATE', 'PAYMENT_PLAN_CANCEL')
        AND "paymentPlanId" IS NOT NULL AND "paymentId" IS NULL)
    ),
    -- Solo se registra lo que de verdad tocó un día cerrado.
    CONSTRAINT "financial_lock_overrides_day_check" CHECK ("businessDate" <= "lockedThrough"),
    CONSTRAINT "financial_lock_overrides_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "financial_lock_overrides_location_fkey" FOREIGN KEY ("tenantId", "locationId")
      REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "financial_lock_overrides_payment_fkey" FOREIGN KEY ("tenantId", "paymentId")
      REFERENCES "payments"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "financial_lock_overrides_payment_plan_fkey" FOREIGN KEY ("tenantId", "paymentPlanId")
      REFERENCES "payment_plans"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Listado reciente de Ajustes y lado hijo de cada FK compuesta.
CREATE INDEX "financial_lock_overrides_tenant_created_idx" ON "financial_lock_overrides"("tenantId", "createdAt" DESC);
CREATE INDEX "financial_lock_overrides_payment_idx" ON "financial_lock_overrides"("tenantId", "paymentId");
CREATE INDEX "financial_lock_overrides_payment_plan_idx" ON "financial_lock_overrides"("tenantId", "paymentPlanId");
CREATE INDEX "financial_lock_overrides_location_idx" ON "financial_lock_overrides"("tenantId", "locationId");

ALTER TABLE "financial_lock_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "financial_lock_overrides" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "financial_lock_overrides"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON "financial_lock_overrides" FROM dentalix_app;
GRANT SELECT, INSERT ON "financial_lock_overrides" TO dentalix_app;

-- search_path fijo con pg_temp AL FINAL y pg_catalog.pg_roles calificado
-- (SEC-032), como el guard de payment_adjustments (DX-516).
CREATE FUNCTION public.dx_financial_lock_override_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'financial_lock_overrides no admite %: el registro de excepciones al cierre contable no se borra (DX-091)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'financial_lock_overrides es inalterable (DX-091)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- INSERT: la hora es la del servidor (DX-226), nunca la de la app.
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "financial_lock_overrides_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "financial_lock_overrides"
  FOR EACH ROW EXECUTE FUNCTION public.dx_financial_lock_override_guard();
CREATE TRIGGER "financial_lock_overrides_no_truncate"
  BEFORE TRUNCATE ON "financial_lock_overrides"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_financial_lock_override_guard();

-- ---------------------------------------------------------------------------
-- 3. El cierre efectivo y la guarda de payments
-- ---------------------------------------------------------------------------

-- El último día cerrado (inclusive) de la clínica con «hoy» en la zona
-- p_zone, o NULL sin cierre. GREATEST ignora los NULL: rige el más tardío.
-- Misma regla que `lockedThrough` (src/modules/financial-lock/domain).
CREATE FUNCTION public.dx_financial_locked_through(p_tenant uuid, p_zone text)
  RETURNS date
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT GREATEST(
           t."financialLockDate",
           CASE
             WHEN t."financialLockDays" IS NULL OR p_zone IS NULL THEN NULL
             ELSE (pg_catalog.timezone(p_zone, pg_catalog.now()))::date
                  - (t."financialLockDays" + 1)
           END)
    FROM public.tenants t
   WHERE t."id" = p_tenant
$$;

CREATE FUNCTION public.dx_payments_financial_lock_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_tenant uuid;
  v_location uuid;
  v_paid timestamp(3);
  v_lock_date date;
  v_lock_days integer;
  v_zone text;
  v_through date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."deletedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    v_id := NEW."id"; v_tenant := NEW."tenantId";
    v_location := NEW."locationId"; v_paid := NEW."paidAt";
  ELSIF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL THEN
    -- Anular: cuenta el día del abono tal como estaba.
    v_id := OLD."id"; v_tenant := OLD."tenantId";
    v_location := OLD."locationId"; v_paid := OLD."paidAt";
  ELSE
    RETURN NEW;
  END IF;

  SELECT t."financialLockDate", t."financialLockDays"
    INTO v_lock_date, v_lock_days
    FROM public.tenants t
   WHERE t."id" = v_tenant;
  IF v_lock_date IS NULL AND v_lock_days IS NULL THEN
    RETURN NEW;
  END IF;

  -- Fixtures y mantenimiento del dueño, como payments_void_immutable.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN NEW;
  END IF;

  IF v_id::text = ANY (pg_catalog.string_to_array(
       COALESCE(pg_catalog.current_setting('dentalix.financial_lock_override', true), ''),
       ',')) THEN
    RETURN NEW;
  END IF;

  SELECT l."timeZone" INTO v_zone
    FROM public.locations l
   WHERE l."tenantId" = v_tenant AND l."id" = v_location;
  -- Sin zona no hay día civil con el que medir: con cierre configurado se
  -- rechaza (la app ya exige la zona antes, 409 LOCATION_TIMEZONE_REQUIRED).
  IF v_zone IS NOT NULL THEN
    v_through := public.dx_financial_locked_through(v_tenant, v_zone);
    IF v_through IS NULL
       OR (pg_catalog.timezone(v_zone, pg_catalog.timezone('UTC', v_paid)))::date > v_through THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'El abono es de un período contable cerrado (DX-091)'
    USING ERRCODE = 'Q0910';
END;
$$;

CREATE TRIGGER "payments_financial_lock_guard"
  BEFORE INSERT OR UPDATE OF "deletedAt" ON "payments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payments_financial_lock_guard();
