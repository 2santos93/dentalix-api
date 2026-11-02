-- DX-516: ajustes por medio de pago (impuesto, recargo o descuento) que la
-- clínica configura en cada medio de su catálogo (DX-377) y que cada abono
-- congela como líneas propias. Nada por país: tipos genéricos, etiqueta libre,
-- ningún ajuste precargado (por defecto, ningún medio tiene ajustes).
--
-- Cambios:
--   "PaymentAdjustmentType"         TAX | SURCHARGE | DISCOUNT.
--   "PaymentAdjustmentCalculation"  PERCENT | FIXED.
--   payment_method_adjustments      configuración por medio: tipo, etiqueta
--                                   (1..40, una línea), porcentaje (0 < p <=
--                                   100, 2 decimales) o importe fijo (> 0) con
--                                   su moneda (solo se aplica a abonos en esa
--                                   moneda), activo. No se borra: se desactiva.
--                                   FK COMPUESTA al medio (misma clínica).
--   payment_adjustments             lo congelado en el abono (append-only):
--                                   tipo, etiqueta, cálculo tal como estaba,
--                                   base (= importe del abono), importe (> 0,
--                                   en la moneda del abono) y posición (1..5).
--                                   FK COMPUESTA al abono; puntero suave al
--                                   ajuste de origen (sin FK: la configuración
--                                   cambia y la línea no). Un trigger impide
--                                   UPDATE y DELETE (salvo el superusuario de
--                                   los fixtures) y en el INSERT comprueba que
--                                   moneda y base son las del abono.
--
-- La regla de totales (SPEC-DX-516 §2): `payments.amount` sigue siendo lo que
-- se acredita al plan. Impuestos y recargos se cobran aparte; los descuentos
-- cuentan como abono. Lo cobrado = importe + impuestos + recargos − descuentos.
--
-- Compatible hacia atrás: solo AÑADE (dos enums, dos tablas vacías con RLS).
-- Una réplica anterior no las conoce: sus abonos nacen sin ajustes, que es lo
-- mismo que «sin configurar». Grants: ALTER DEFAULT PRIVILEGES ya cubre a
-- dentalix_app en tablas nuevas; aquí se le quita lo que no debe hacer.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "PaymentAdjustmentType" AS ENUM ('TAX', 'SURCHARGE', 'DISCOUNT');
CREATE TYPE "PaymentAdjustmentCalculation" AS ENUM ('PERCENT', 'FIXED');

-- ---------------------------------------------------------------------------
-- 1. Configuración
-- ---------------------------------------------------------------------------
CREATE TABLE "payment_method_adjustments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "paymentMethodId" UUID NOT NULL,
    "type" "PaymentAdjustmentType" NOT NULL,
    "label" TEXT NOT NULL,
    "calculation" "PaymentAdjustmentCalculation" NOT NULL,
    "percent" DECIMAL(5,2),
    "fixedAmount" DECIMAL(14,2),
    "fixedCurrency" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_method_adjustments_pkey" PRIMARY KEY ("id"),
    -- La API responde 400 en español antes; esto es la red.
    CONSTRAINT "payment_method_adjustments_label_check" CHECK (
      length(btrim("label")) BETWEEN 1 AND 40
      AND "label" = btrim("label")
      AND "label" !~ '[[:cntrl:]]'
    ),
    CONSTRAINT "payment_method_adjustments_calculation_check" CHECK (
      ("calculation" = 'PERCENT'
        AND "percent" IS NOT NULL AND "percent" > 0 AND "percent" <= 100
        AND "fixedAmount" IS NULL AND "fixedCurrency" IS NULL)
      OR ("calculation" = 'FIXED'
        AND "percent" IS NULL
        AND "fixedAmount" IS NOT NULL AND "fixedAmount" > 0
        AND "fixedCurrency" IS NOT NULL)
    ),
    CONSTRAINT "payment_method_adjustments_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_method_adjustments_method_fkey" FOREIGN KEY ("tenantId", "paymentMethodId")
      REFERENCES "payment_methods"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_method_adjustments_currency_fkey" FOREIGN KEY ("fixedCurrency")
      REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Lado hijo de la FK compuesta y listado por medio.
CREATE INDEX "payment_method_adjustments_tenant_method_idx"
  ON "payment_method_adjustments"("tenantId", "paymentMethodId");
-- Único (tenantId, id), como el del medio (lecturas por clínica).
CREATE UNIQUE INDEX "payment_method_adjustments_tenant_id_key"
  ON "payment_method_adjustments"("tenantId", "id");

ALTER TABLE "payment_method_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_method_adjustments" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "payment_method_adjustments"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- La app lee, da de alta y edita; nunca borra (un ajuste se desactiva).
REVOKE DELETE, TRUNCATE ON "payment_method_adjustments" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- 2. Lo congelado en el abono (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE "payment_adjustments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "sourceAdjustmentId" UUID,
    "type" "PaymentAdjustmentType" NOT NULL,
    "label" TEXT NOT NULL,
    "calculation" "PaymentAdjustmentCalculation" NOT NULL,
    "percent" DECIMAL(5,2),
    "fixedAmount" DECIMAL(14,2),
    "base" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_adjustments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_adjustments_position_check" CHECK ("position" BETWEEN 1 AND 5),
    CONSTRAINT "payment_adjustments_label_check" CHECK (length(btrim("label")) BETWEEN 1 AND 40),
    CONSTRAINT "payment_adjustments_amount_check" CHECK ("amount" > 0 AND "base" > 0),
    CONSTRAINT "payment_adjustments_calculation_check" CHECK (
      ("calculation" = 'PERCENT' AND "percent" IS NOT NULL AND "fixedAmount" IS NULL)
      OR ("calculation" = 'FIXED' AND "percent" IS NULL AND "fixedAmount" IS NOT NULL)
    ),
    CONSTRAINT "payment_adjustments_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- CASCADE solo lo ejerce el superusuario de los fixtures (la app no borra
    -- abonos: se anulan, y el abono anulado arrastra sus líneas).
    CONSTRAINT "payment_adjustments_payment_fkey" FOREIGN KEY ("tenantId", "paymentId")
      REFERENCES "payments"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "payment_adjustments_currency_fkey" FOREIGN KEY ("currency")
      REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Una línea por posición en cada abono; también el lado hijo de la FK.
CREATE UNIQUE INDEX "payment_adjustments_tenant_payment_position_key"
  ON "payment_adjustments"("tenantId", "paymentId", "position");

ALTER TABLE "payment_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_adjustments" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "payment_adjustments"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON "payment_adjustments" FROM dentalix_app;
GRANT SELECT, INSERT ON "payment_adjustments" TO dentalix_app;

-- search_path fijo con pg_temp AL FINAL y pg_catalog.pg_roles calificado
-- (SEC-032), como el guard de payment_receipts (DX-136).
CREATE FUNCTION public.dx_payment_adjustment_guard() RETURNS trigger
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
    RAISE EXCEPTION 'payment_adjustments no admite %: el ajuste de un abono no se borra; se anula el abono (DX-516)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'payment_adjustments es inalterable: el ajuste queda congelado en el abono (DX-516)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- INSERT: la hora del servidor (DX-226) y la coherencia con su abono.
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  IF NOT EXISTS (
    SELECT 1 FROM public.payments p
     WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."paymentId"
       AND p."currency" = NEW."currency" AND p."amount" = NEW."base"
       AND p."deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'El ajuste tiene que ser de un abono vivo de la misma clínica, en su moneda y sobre su importe (DX-516)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_adjustments_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "payment_adjustments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payment_adjustment_guard();
CREATE TRIGGER "payment_adjustments_no_truncate"
  BEFORE TRUNCATE ON "payment_adjustments"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_payment_adjustment_guard();
