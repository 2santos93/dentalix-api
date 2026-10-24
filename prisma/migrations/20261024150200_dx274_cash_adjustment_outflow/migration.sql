-- DX-274: la caja admite la anulación de una salida de caja menor.
--
-- Cambios:
--   cash_session_adjustments."expensePaymentId"  la salida (pago de gasto con
--                       caja) que anula un ajuste OUTFLOW_VOID. FK compuesta
--                       por tenant a expense_payments.
--   cash_session_adjustments_kind_check  reescrito (ver abajo).
--   cash_session_adjustments_expense_payment_kind_key  UNIQUE parcial
--                       ("expensePaymentId", "kind"): una salida se anula en
--                       caja una sola vez.
--   dx_cash_adjustment_guard()  ampliado: el pago de gasto es de la clínica y
--                       de la sede del ajuste, y "expensePaymentId" no cambia
--                       al unir el ajuste pendiente a una caja.
--
-- Reglas en la BD (CHECK de "kind"):
--   VOID, LATE_PAYMENT, CORRECTION  como en DX-027, y además
--                       "expensePaymentId" IS NULL.
--   OUTFLOW_VOID        "expensePaymentId" NOT NULL, "amount" > 0 (devuelve
--                       el efectivo que la salida restó), "originalSessionId"
--                       (la caja cerrada de la salida) y "reason" NOT NULL,
--                       "method" = 'CASH' y "paymentId" NULL.
--
-- Cuerpo de dx_cash_adjustment_guard copiado de
-- 20261019090100_dx226_cash_sessions_server_time_utc (hora UTC) con solo las
-- dos adiciones de arriba. Mismo nombre, firma, dueño y search_path.
--
-- DX-134: la FK nueva se añade con FORCE quitado en las dos tablas (hija
-- cash_session_adjustments y referenciada expense_payments) y devuelto al
-- final; la columna es nueva y está entera a NULL. El CHECK se añade NOT VALID
-- y se valida en la misma migración (SHARE UPDATE EXCLUSIVE, no bloquea
-- escrituras durante el recorrido).
--
-- Compatible hacia atrás: AÑADE una columna NULL, un índice y una FK; el CHECK
-- nuevo acepta todo lo que aceptaba el anterior (la columna es NULL en las
-- filas existentes). El código anterior no usa OUTFLOW_VOID.
--
-- Grants: sin tablas nuevas; las funciones conservan sus privilegios.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "cash_session_adjustments" ADD COLUMN "expensePaymentId" UUID;

-- DX-134: sin FORCE hasta el final.
ALTER TABLE "cash_session_adjustments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "expense_payments" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "cash_session_adjustments"
  ADD CONSTRAINT "cash_session_adjustments_expense_payment_fkey"
  FOREIGN KEY ("tenantId", "expensePaymentId") REFERENCES "expense_payments"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "expense_payments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cash_session_adjustments" FORCE ROW LEVEL SECURITY;

-- Una anulación de salida por salida, como mucho (y búsqueda por salida).
CREATE UNIQUE INDEX "cash_session_adjustments_expense_payment_kind_key"
  ON "cash_session_adjustments"("expensePaymentId", "kind") WHERE "expensePaymentId" IS NOT NULL;

ALTER TABLE "cash_session_adjustments" DROP CONSTRAINT "cash_session_adjustments_kind_check";
ALTER TABLE "cash_session_adjustments"
  ADD CONSTRAINT "cash_session_adjustments_kind_check"
  CHECK (
    ("kind" = 'VOID' AND "paymentId" IS NOT NULL AND "expensePaymentId" IS NULL AND "amount" < 0)
    OR ("kind" = 'LATE_PAYMENT' AND "paymentId" IS NOT NULL AND "expensePaymentId" IS NULL AND "amount" > 0)
    OR ("kind" = 'CORRECTION' AND "paymentId" IS NULL AND "expensePaymentId" IS NULL AND "amount" <> 0
        AND "originalSessionId" IS NOT NULL AND "reason" IS NOT NULL)
    OR ("kind" = 'OUTFLOW_VOID' AND "paymentId" IS NULL AND "expensePaymentId" IS NOT NULL
        AND "amount" > 0 AND "originalSessionId" IS NOT NULL AND "reason" IS NOT NULL
        AND "method" = 'CASH')
  ) NOT VALID;
ALTER TABLE "cash_session_adjustments" VALIDATE CONSTRAINT "cash_session_adjustments_kind_check";

-- Ajustes: el abono o la salida es de la misma clínica y sede; la caja de
-- destino está abierta y es de la sede; la de origen, de la sede. Lo único que
-- cambia después es unir un ajuste pendiente a una caja abierta, una vez.
CREATE OR REPLACE FUNCTION public.dx_cash_adjustment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF public.dx_cash_is_superuser() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'cash_session_adjustments no admite %: un ajuste no se borra (DX-027)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."sessionId" IS NOT NULL OR NEW."sessionId" IS NULL
       OR (NEW."id", NEW."tenantId", NEW."locationId", NEW."kind", NEW."paymentId",
           NEW."expensePaymentId", NEW."originalSessionId", NEW."currency", NEW."method",
           NEW."amount", NEW."reason", NEW."createdById", NEW."createdAt")
          IS DISTINCT FROM
          (OLD."id", OLD."tenantId", OLD."locationId", OLD."kind", OLD."paymentId",
           OLD."expensePaymentId", OLD."originalSessionId", OLD."currency", OLD."method",
           OLD."amount", OLD."reason", OLD."createdById", OLD."createdAt")
    THEN
      RAISE EXCEPTION 'cash_session_adjustments es inalterable: un ajuste pendiente solo se une una vez a una caja abierta (DX-027)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    IF NEW."paymentId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.payments p
       WHERE p."id" = NEW."paymentId" AND p."tenantId" = NEW."tenantId"
         AND p."locationId" = NEW."locationId"
    ) THEN
      RAISE EXCEPTION 'El abono del ajuste no es de esta clínica y sede (DX-027)'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW."expensePaymentId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.expense_payments e
       WHERE e."id" = NEW."expensePaymentId" AND e."tenantId" = NEW."tenantId"
         AND e."locationId" = NEW."locationId"
    ) THEN
      RAISE EXCEPTION 'El pago de gasto del ajuste no es de esta clínica y sede (DX-274)'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW."originalSessionId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.cash_sessions s
       WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."originalSessionId"
         AND s."locationId" = NEW."locationId"
    ) THEN
      RAISE EXCEPTION 'La caja de origen del ajuste no es de esta sede (DX-027)'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  IF NEW."sessionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cash_sessions s
     WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sessionId"
       AND s."locationId" = NEW."locationId" AND s."status" = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'Un ajuste solo entra en una caja abierta de su sede (DX-027)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
