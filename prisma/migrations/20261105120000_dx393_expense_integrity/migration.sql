-- DX-393 (auditoría DB-058): la BD hace de red de la vida y del tope de los
-- pagos de un gasto, y de la anulación de una salida de caja menor. Hasta
-- ahora solo lo aplicaba la app (con el gasto `FOR UPDATE`); estas filas se
-- podían escribir como dentalix_app: un gasto anulado de 10 con 580 pagados.
--
-- Cambios (CREATE OR REPLACE: los triggers que usan las funciones no se tocan;
-- mismo nombre, firma, dueño, SECURITY INVOKER y search_path; los cuerpos son
-- los de 20261024150500 y 20261024150200 con solo lo marcado «DX-393»):
--   dx_expense_payment_guard (INSERT)  el gasto no está anulado (Q3930) y
--                       Σ pagos vivos + el nuevo ≤ importe (Q3931). Lee el
--                       gasto FOR NO KEY UPDATE: choca con el FOR UPDATE de la
--                       app y con otra alta, anulación o rebaja simultánea.
--   dx_expense_guard (UPDATE)  el importe no baja de lo pagado en vivo
--                       (Q3932) y no se anula con pagos vivos (Q3933).
--   dx_cash_adjustment_guard (INSERT)  un OUTFLOW_VOID lleva el importe y la
--                       moneda de la salida, su "originalSessionId" es la caja
--                       de la salida y la salida está anulada (Q3934).
--
-- ERRCODE propios de clase Q3 (implementación, I–Z; A–H los reserva el
-- estándar SQL): el filtro de errores de la API los traduce a 409 en español,
-- como Q0271 (DX-271). El mensaje de Postgres es el mismo texto.
--
-- Solo validan escrituras NUEVAS: no recorren ni cambian filas, así que la
-- migración no falla si ya hay datos incoherentes. Se listan, sin tocarlos,
-- con prisma/scripts/expense-integrity-report.sql (README, «Integridad entre
-- gasto y pagos (DX-393)»). Anular los pagos vivos de una fila ya
-- incoherente sigue permitido: es como se corrige.
--
-- Compatible hacia atrás: la app anterior ya cumple estas reglas antes de
-- escribir (mismos bloqueos), así que nada de lo que hace cambia de resultado.
-- Sin tablas, columnas, índices ni grants nuevos.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.dx_expense_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF public.dx_cash_is_superuser() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'expenses no admite %: un gasto no se borra, se anula (DX-274)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."voidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Un gasto nace sin anular (DX-274)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."tenantId", NEW."createdById", NEW."createdAt",
      NEW."idempotencyKey", NEW."idempotencyFingerprint")
     IS DISTINCT FROM (OLD."id", OLD."tenantId", OLD."createdById", OLD."createdAt",
      OLD."idempotencyKey", OLD."idempotencyFingerprint")
  THEN
    RAISE EXCEPTION 'expenses es inalterable en su identidad: clínica, autor, alta y clave de idempotencia no cambian (DX-274)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Soporte: vacío -> lleno una vez; después no cambia.
  IF OLD."attachmentKey" IS NOT NULL
     AND (NEW."attachmentKey", NEW."attachmentMime", NEW."attachmentSize",
          NEW."attachmentSha256", NEW."attachmentName")
         IS DISTINCT FROM
         (OLD."attachmentKey", OLD."attachmentMime", OLD."attachmentSize",
          OLD."attachmentSha256", OLD."attachmentName")
  THEN
    RAISE EXCEPTION 'El soporte de un gasto se fija una vez y no cambia (DX-274)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- DX-393: el importe no baja de lo pagado en vivo. Solo si baja: subirlo o
  -- no tocarlo no puede dejar el gasto pagado de más. La fila del gasto ya
  -- está bloqueada por este UPDATE, y el alta de un pago la bloquea también
  -- (dx_expense_payment_guard): los dos no se cruzan.
  IF NEW."amount" < OLD."amount" AND NEW."amount" < (
    SELECT COALESCE(SUM(p."amount"), 0) FROM public.expense_payments p
     WHERE p."tenantId" = OLD."tenantId" AND p."expenseId" = OLD."id"
       AND p."voidedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'El importe no puede ser menor a lo ya pagado. Recarga el gasto y vuelve a intentarlo.'
      USING ERRCODE = 'Q3932';
  END IF;

  -- Anulación: vacía -> llena una vez, con la hora del servidor; no se deshace.
  IF OLD."voidedAt" IS NOT NULL THEN
    IF (NEW."voidedAt", NEW."voidedById", NEW."voidReason")
       IS DISTINCT FROM (OLD."voidedAt", OLD."voidedById", OLD."voidReason")
    THEN
      RAISE EXCEPTION 'Un gasto anulado no se anula de nuevo ni se reactiva (DX-274)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW."voidedAt" IS NOT NULL THEN
    -- DX-393: un gasto se anula sin pagos vivos (la app anula antes cada
    -- pago, en la misma transacción).
    IF EXISTS (
      SELECT 1 FROM public.expense_payments p
       WHERE p."tenantId" = OLD."tenantId" AND p."expenseId" = OLD."id"
         AND p."voidedAt" IS NULL
    ) THEN
      RAISE EXCEPTION 'El gasto tiene pagos sin anular: anúlalos antes de anular el gasto. Recarga el gasto y vuelve a intentarlo.'
        USING ERRCODE = 'Q3933';
    END IF;
    NEW."voidedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.dx_expense_payment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  expense record;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF public.dx_cash_is_superuser() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'expense_payments no admite %: un pago no se borra, se anula (DX-274)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."voidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Un pago de gasto nace sin anular (DX-274)' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."cashSessionId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.cash_sessions s
       WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."cashSessionId"
         AND s."locationId" = NEW."locationId" AND s."status" = 'OPEN'
    ) THEN
      RAISE EXCEPTION 'Una salida de caja solo entra en una caja abierta de su sede (DX-274)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- DX-393: el gasto vive y el pago cabe en lo pendiente. FOR NO KEY UPDATE:
    -- dos altas de pago del mismo gasto, o un alta y una anulación o una
    -- rebaja del importe, se esperan; la segunda lee lo que dejó la primera.
    -- Sin fila (otra clínica bajo RLS o inexistente) decide la FK compuesta.
    SELECT e."amount", e."voidedAt" INTO expense
      FROM public.expenses e
     WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."expenseId"
     FOR NO KEY UPDATE;
    IF FOUND THEN
      IF expense."voidedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'El gasto está anulado: ya no admite pagos.'
          USING ERRCODE = 'Q3930';
      END IF;
      IF NEW."amount" + (
        SELECT COALESCE(SUM(p."amount"), 0) FROM public.expense_payments p
         WHERE p."tenantId" = NEW."tenantId" AND p."expenseId" = NEW."expenseId"
           AND p."voidedAt" IS NULL
      ) > expense."amount" THEN
        RAISE EXCEPTION 'El pago supera lo pendiente del gasto. Recarga el gasto y vuelve a intentarlo.'
          USING ERRCODE = 'Q3931';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: solo la anulación (vacía -> llena), una vez; nada más cambia.
  IF OLD."voidedAt" IS NOT NULL OR NEW."voidedAt" IS NULL
     OR (NEW."id", NEW."tenantId", NEW."expenseId", NEW."locationId", NEW."amount",
         NEW."currency", NEW."method", NEW."paidOn", NEW."cashSessionId",
         NEW."createdById", NEW."createdAt",
         NEW."idempotencyKey", NEW."idempotencyFingerprint")
        IS DISTINCT FROM
        (OLD."id", OLD."tenantId", OLD."expenseId", OLD."locationId", OLD."amount",
         OLD."currency", OLD."method", OLD."paidOn", OLD."cashSessionId",
         OLD."createdById", OLD."createdAt",
         OLD."idempotencyKey", OLD."idempotencyFingerprint")
  THEN
    RAISE EXCEPTION 'expense_payments es inalterable: un pago solo se anula, una vez (DX-274)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."voidedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

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
    -- DX-393: OUTFLOW_VOID devuelve justo lo que restó la salida, en su
    -- moneda, contra la caja de la que salió, y solo de una salida ya anulada
    -- (la app la anula antes en la misma transacción; anulada no cambia).
    -- Sin salida lo rechaza el CHECK de "kind".
    IF NEW."kind" = 'OUTFLOW_VOID' AND NEW."expensePaymentId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.expense_payments e
       WHERE e."id" = NEW."expensePaymentId" AND e."tenantId" = NEW."tenantId"
         AND e."amount" = NEW."amount" AND e."currency" = NEW."currency"
         AND e."cashSessionId" = NEW."originalSessionId"
         AND e."voidedAt" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'La anulación de la salida no coincide con su importe o con su caja. Vuelve a intentarlo.'
        USING ERRCODE = 'Q3934';
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
