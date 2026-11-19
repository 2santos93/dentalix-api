-- DX-570: vuelto al cobrar en efectivo, entregado en otra moneda o por otro
-- medio, en el mismo abono.
--
-- Cambios:
--   payments."tenderedAmount"   lo que entregó el paciente («Recibido»), en la
--                       moneda del abono; NULL = cobro sin vuelto (como hasta
--                       ahora). Solo en efectivo (CHECK payments_tendered_check,
--                       NOT VALID; se valida en 20270120090200). No cambia
--                       después, y con él tampoco el importe, la moneda ni el
--                       método (trigger payments_tendered_immutable).
--   payments."changeRemainder"  la diferencia no devuelta que, confirmada, se
--                       sumó al importe (saldo a favor si supera lo pendiente);
--                       NULL si el vuelto cubrió todo. Solo con «Recibido».
--   payment_change_lines        las líneas del vuelto (1..3), append-only:
--                       medio del catálogo (FK compuesta), su tipo base antiguo
--                       (el del arqueo), moneda, importe (> 0), referencia (si
--                       el medio la pide; la API lo exige), su equivalente en la
--                       moneda del abono (> 0) y la tasa del día congelada (las
--                       cuatro columnas juntas; ninguna en la misma moneda).
--                       FK COMPUESTA al abono. Un trigger impide UPDATE y
--                       DELETE (salvo el superusuario de los fixtures) y en el
--                       INSERT comprueba que el abono es vivo, de la clínica,
--                       con «Recibido».
--   payments_change_balance     trigger de restricción DIFERIDO al COMMIT: en un
--                       abono con «Recibido», recibido = importe + ajustes por
--                       medio de pago (DX-516, con signo) + equivalentes del
--                       vuelto. La API lo calcula antes; esto es la red.
--   cash_session_adjustments."paymentChangeLineId"  la línea de vuelto de un
--                       ajuste CHANGE_LATE o CHANGE_VOID. FK compuesta por
--                       tenant. Único parcial (línea, kind): una vez cada uno.
--                       "paymentId" va NULL en esas filas (el único
--                       cash_session_adjustments_payment_kind_key admite un
--                       VOID y un LATE_PAYMENT por abono, no uno por línea):
--                       el abono se llega por la línea.
--   cash_session_adjustments_kind_check  reescrito, NOT VALID (se valida en
--                       20270120090200): las clases de antes con
--                       "paymentChangeLineId" NULL; CHANGE_LATE resta y
--                       CHANGE_VOID suma, las dos con línea y sin abono ni
--                       salida directos.
--   dx_cash_change_adjustment_guard()  BEFORE INSERT/UPDATE en
--                       cash_session_adjustments, aparte del guard de DX-027
--                       (que no se toca): la línea es de la clínica y sede del
--                       ajuste, con su moneda, método e importe; CHANGE_VOID
--                       solo de un abono ya anulado; la línea no cambia al unir
--                       un ajuste pendiente a una caja.
--
-- No toca pacientes: las líneas cuelgan del abono (su paciente lo lleva
-- payments), así que la fusión de pacientes (dx_merge_patients) no cambia.
--
-- DX-134: las FK nuevas hacia tablas con FORCE se añaden con FORCE quitado en
-- hija y referenciada y devuelto al final.
--
-- Compatible hacia atrás: AÑADE una columna NULL en payments y en
-- cash_session_adjustments, una tabla vacía con RLS y triggers que solo actúan
-- cuando hay «Recibido» o línea de vuelto; el CHECK nuevo acepta todo lo que
-- aceptaba el anterior (la columna nueva es NULL en las filas existentes). Una
-- réplica anterior no escribe las columnas nuevas: sus abonos nacen sin vuelto.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. «Recibido» en el abono
-- ---------------------------------------------------------------------------
ALTER TABLE "payments"
  ADD COLUMN "tenderedAmount" DECIMAL(14,2),
  ADD COLUMN "changeRemainder" DECIMAL(14,2);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_tendered_check" CHECK (
    (
      "tenderedAmount" IS NULL AND "changeRemainder" IS NULL
    )
    OR (
      "tenderedAmount" > 0 AND "method" = 'CASH' AND "splitId" IS NULL
      AND "treatmentPlanId" IS NOT NULL
      AND ("changeRemainder" IS NULL OR "changeRemainder" > 0)
    )
  ) NOT VALID;

-- ---------------------------------------------------------------------------
-- 2. Líneas del vuelto (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE "payment_change_lines" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "line" SMALLINT NOT NULL,
    "paymentMethodId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,
    "referenceNormalized" TEXT,
    "equivalentAmount" DECIMAL(14,2) NOT NULL,
    "exchangeRateFrom" DECIMAL(18,8),
    "exchangeRateTo" DECIMAL(18,8),
    "exchangeRateSource" "ExchangeRateSource",
    "exchangeRateDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_change_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_change_lines_line_check" CHECK ("line" BETWEEN 1 AND 3),
    CONSTRAINT "payment_change_lines_amount_check"
      CHECK ("amount" > 0 AND "equivalentAmount" > 0),
    CONSTRAINT "payment_change_lines_reference_check" CHECK (
      ("reference" IS NULL AND "referenceNormalized" IS NULL)
      OR (
        length(btrim("reference")) BETWEEN 1 AND 60
        AND "referenceNormalized" IS NOT NULL
        AND length("referenceNormalized") BETWEEN 1 AND 60
      )
    ),
    -- Las cuatro columnas de la tasa van juntas y positivas (como
    -- payments_exchange_rate_check).
    CONSTRAINT "payment_change_lines_exchange_rate_check" CHECK (
      (
        "exchangeRateFrom" IS NULL AND "exchangeRateTo" IS NULL
        AND "exchangeRateSource" IS NULL AND "exchangeRateDate" IS NULL
      )
      OR (
        "exchangeRateFrom" IS NOT NULL AND "exchangeRateFrom" > 0
        AND "exchangeRateTo" IS NOT NULL AND "exchangeRateTo" > 0
        AND "exchangeRateSource" IS NOT NULL AND "exchangeRateDate" IS NOT NULL
      )
    ),
    CONSTRAINT "payment_change_lines_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_change_lines_payment_fkey" FOREIGN KEY ("tenantId", "paymentId")
      REFERENCES "payments"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_change_lines_payment_method_fkey" FOREIGN KEY ("tenantId", "paymentMethodId")
      REFERENCES "payment_methods"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_change_lines_currency_fkey" FOREIGN KEY ("currency")
      REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Una línea por número en cada abono; también el lado hijo de la FK al abono.
CREATE UNIQUE INDEX "payment_change_lines_tenant_payment_line_key"
  ON "payment_change_lines"("tenantId", "paymentId", "line");
-- Destino de la FK compuesta de cash_session_adjustments.
CREATE UNIQUE INDEX "payment_change_lines_tenant_id_key"
  ON "payment_change_lines"("tenantId", "id");
-- Lado hijo de la FK al medio y de la de moneda.
CREATE INDEX "payment_change_lines_tenant_method_idx"
  ON "payment_change_lines"("tenantId", "paymentMethodId");
CREATE INDEX "payment_change_lines_currency_idx"
  ON "payment_change_lines"("currency");

ALTER TABLE "payment_change_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_change_lines" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "payment_change_lines"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON "payment_change_lines" FROM dentalix_app;
GRANT SELECT, INSERT ON "payment_change_lines" TO dentalix_app;

-- search_path fijo con pg_temp AL FINAL y catálogo calificado (SEC-032).
CREATE FUNCTION public.dx_payment_change_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF public.dx_cash_is_superuser() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'payment_change_lines no admite %: el vuelto de un abono no se borra; se anula el abono (DX-570)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF public.dx_cash_is_superuser() THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'payment_change_lines es inalterable: el vuelto queda congelado en el abono (DX-570)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- INSERT: la hora del servidor (DX-226) y un abono vivo con «Recibido».
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  IF NOT EXISTS (
    SELECT 1 FROM public.payments p
     WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."paymentId"
       AND p."tenderedAmount" IS NOT NULL
       AND p."deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'El vuelto tiene que ser de un abono vivo en efectivo de la misma clínica, con lo recibido (DX-570)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_change_lines_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "payment_change_lines"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payment_change_line_guard();
CREATE TRIGGER "payment_change_lines_no_truncate"
  BEFORE TRUNCATE ON "payment_change_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_payment_change_line_guard();

-- ---------------------------------------------------------------------------
-- 3. «Recibido» no cambia, y cuadra con lo cobrado y el vuelto al COMMIT
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_payment_tendered_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF public.dx_cash_is_superuser() THEN
    RETURN NEW;
  END IF;
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF (NEW."tenderedAmount", NEW."changeRemainder")
       IS DISTINCT FROM (OLD."tenderedAmount", OLD."changeRemainder")
     OR (OLD."tenderedAmount" IS NOT NULL
         AND (NEW."amount", NEW."currency", NEW."method")
             IS DISTINCT FROM (OLD."amount", OLD."currency", OLD."method"))
  THEN
    RAISE EXCEPTION 'Lo recibido de un abono con vuelto no cambia, ni su importe, moneda o método (DX-570)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_tendered_immutable"
  BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payment_tendered_immutable();

CREATE FUNCTION public.dx_payment_change_balance() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  adjustments_net numeric;
  change_total numeric;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN a."type" = 'DISCOUNT' THEN -a."amount" ELSE a."amount" END), 0)
    INTO adjustments_net
    FROM public.payment_adjustments a
   WHERE a."tenantId" = NEW."tenantId" AND a."paymentId" = NEW."id";
  SELECT COALESCE(SUM(c."equivalentAmount"), 0)
    INTO change_total
    FROM public.payment_change_lines c
   WHERE c."tenantId" = NEW."tenantId" AND c."paymentId" = NEW."id";
  IF NEW."tenderedAmount" <> NEW."amount" + adjustments_net + change_total THEN
    RAISE EXCEPTION 'Lo recibido no cuadra con lo cobrado más el vuelto. Vuelve a registrar el abono.'
      USING ERRCODE = 'Q3570';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payments_change_balance"
  AFTER INSERT ON "payments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."tenderedAmount" IS NOT NULL)
  EXECUTE FUNCTION public.dx_payment_change_balance();

-- ---------------------------------------------------------------------------
-- 4. Ajustes de caja de una línea de vuelto
-- ---------------------------------------------------------------------------
ALTER TABLE "cash_session_adjustments" ADD COLUMN "paymentChangeLineId" UUID;

-- DX-134: sin FORCE hasta el final.
ALTER TABLE "cash_session_adjustments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_change_lines" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "cash_session_adjustments"
  ADD CONSTRAINT "cash_session_adjustments_change_line_fkey"
  FOREIGN KEY ("tenantId", "paymentChangeLineId") REFERENCES "payment_change_lines"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cash_session_adjustments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_change_lines" FORCE ROW LEVEL SECURITY;

-- Una vez por línea y clase (y búsqueda por línea).
CREATE UNIQUE INDEX "cash_session_adjustments_change_line_kind_key"
  ON "cash_session_adjustments"("paymentChangeLineId", "kind") WHERE "paymentChangeLineId" IS NOT NULL;

ALTER TABLE "cash_session_adjustments" DROP CONSTRAINT "cash_session_adjustments_kind_check";
ALTER TABLE "cash_session_adjustments"
  ADD CONSTRAINT "cash_session_adjustments_kind_check"
  CHECK (
    ("kind" = 'VOID' AND "paymentId" IS NOT NULL AND "expensePaymentId" IS NULL
        AND "paymentChangeLineId" IS NULL AND "amount" < 0)
    OR ("kind" = 'LATE_PAYMENT' AND "paymentId" IS NOT NULL AND "expensePaymentId" IS NULL
        AND "paymentChangeLineId" IS NULL AND "amount" > 0)
    OR ("kind" = 'CORRECTION' AND "paymentId" IS NULL AND "expensePaymentId" IS NULL
        AND "paymentChangeLineId" IS NULL AND "amount" <> 0
        AND "originalSessionId" IS NOT NULL AND "reason" IS NOT NULL)
    OR ("kind" = 'OUTFLOW_VOID' AND "paymentId" IS NULL AND "expensePaymentId" IS NOT NULL
        AND "paymentChangeLineId" IS NULL
        AND "amount" > 0 AND "originalSessionId" IS NOT NULL AND "reason" IS NOT NULL
        AND "method" = 'CASH')
    OR ("kind" = 'CHANGE_LATE' AND "paymentId" IS NULL AND "expensePaymentId" IS NULL
        AND "paymentChangeLineId" IS NOT NULL AND "amount" < 0
        AND "originalSessionId" IS NOT NULL)
    OR ("kind" = 'CHANGE_VOID' AND "paymentId" IS NULL AND "expensePaymentId" IS NULL
        AND "paymentChangeLineId" IS NOT NULL AND "amount" > 0)
  ) NOT VALID;

CREATE FUNCTION public.dx_cash_change_adjustment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."paymentChangeLineId" IS DISTINCT FROM OLD."paymentChangeLineId" THEN
      RAISE EXCEPTION 'cash_session_adjustments es inalterable: la línea de vuelto de un ajuste no cambia (DX-570)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."paymentChangeLineId" IS NULL THEN
    RETURN NEW;
  END IF;
  -- La línea es de un abono de esta clínica y sede, con su moneda, método e
  -- importe (con el signo de la clase). CHANGE_VOID, solo de un abono ya
  -- anulado (la app lo anula antes, en la misma transacción).
  IF NOT EXISTS (
    SELECT 1 FROM public.payment_change_lines c
      JOIN public.payments p ON p."tenantId" = c."tenantId" AND p."id" = c."paymentId"
     WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."paymentChangeLineId"
       AND p."locationId" = NEW."locationId"
       AND c."currency" = NEW."currency" AND c."method" = NEW."method"
       AND c."amount" = abs(NEW."amount")
       AND (NEW."kind" <> 'CHANGE_VOID' OR p."deletedAt" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'El ajuste de vuelto no coincide con su línea, su abono o su sede. Vuelve a intentarlo.'
      USING ERRCODE = 'Q3571';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "cash_session_adjustments_change_guard"
  BEFORE INSERT OR UPDATE ON "cash_session_adjustments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_cash_change_adjustment_guard();
