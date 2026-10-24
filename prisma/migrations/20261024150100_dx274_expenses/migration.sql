-- DX-274: gastos de la sede y salidas de caja menor.
--
-- Cambios:
--   expense_categories  categorías PROPIAS de la clínica (las predefinidas son
--                       constantes de código). Nombre 2–60, único entre las
--                       vivas por clínica.
--   expenses            el gasto: sede, categoría (foto del nombre), proveedor,
--                       importe y moneda, fecha de factura y vencimiento,
--                       soporte (PDF/JPG/PNG) y anulación. El estado
--                       (PENDING, PARTIAL, PAID, VOIDED) NO se guarda: sale de
--                       "voidedAt" y de la suma de los pagos vivos.
--   expense_payments    pago de un gasto. Con "cashSessionId" es una SALIDA DE
--                       CAJA menor (solo CASH, solo de una caja ABIERTA de la
--                       sede).
--
-- Reglas en la BD:
--   * FK COMPUESTAS por tenant (SEC-004) dentro del CREATE TABLE (tablas
--     vacías; DX-134). La del pago al gasto es de CUATRO columnas
--     (tenantId, expenseId, locationId, currency) contra un UNIQUE del gasto:
--     la sede y la moneda del pago son las del gasto por construcción, sin
--     trigger. ON UPDATE RESTRICT: cambiar la sede o la moneda de un gasto con
--     pagos (aunque estén anulados) queda prohibido en vez de arrastrar los
--     pagos.
--   * expense_payments: CHECK "cashSessionId IS NULL OR method = 'CASH'".
--     Trigger (copia de dx_payment_cash_session_guard, DX-027): un pago con
--     caja solo entra en una caja ABIERTA de su clínica y sede y esa caja no
--     cambia nunca; sin DELETE salvo superusuario (limpieza de tests, como
--     dx_cash_is_superuser); el único UPDATE es la anulación, una sola vez
--     (anulado = voidedAt + voidedById + voidReason).
--   * expenses: sin DELETE (anular no borra) salvo superusuario; el soporte
--     (attachment*) pasa de vacío a lleno una vez y no cambia después; la
--     anulación se fija una vez y no se deshace; el gasto no se reasigna de
--     clínica ni de autor.
--   * "createdAt" (y "voidedAt" al anular) los pone la BD en UTC (DX-226), no
--     el reloj de la API.
--
-- Compatible hacia atrás: solo AÑADE tres tablas vacías, sus índices,
-- funciones y triggers. El código anterior no las conoce.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- expense_categories
-- ---------------------------------------------------------------------------
CREATE TABLE "expense_categories" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "expense_categories_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "expense_categories_name_check"
      CHECK (char_length(btrim("name")) BETWEEN 2 AND 60)
);
-- Nombre único entre las categorías vivas de la clínica (y lado hijo de la FK
-- de tenant).
CREATE UNIQUE INDEX "expense_categories_tenant_name_key"
  ON "expense_categories"("tenantId", "name") WHERE "deletedAt" IS NULL;

-- ---------------------------------------------------------------------------
-- expenses
-- ---------------------------------------------------------------------------
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "supplier" TEXT,
    "description" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "invoiceDate" DATE NOT NULL,
    "dueDate" DATE,
    "attachmentKey" TEXT,
    "attachmentMime" TEXT,
    "attachmentSize" INTEGER,
    "attachmentSha256" TEXT,
    "attachmentName" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "expenses_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "expenses_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "expenses_currency_fkey"
      FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Las reglas del servicio repetidas como red.
    CONSTRAINT "expenses_category_check"
      CHECK (char_length(btrim("category")) BETWEEN 2 AND 60),
    CONSTRAINT "expenses_supplier_check"
      CHECK ("supplier" IS NULL OR char_length("supplier") <= 200),
    CONSTRAINT "expenses_description_check"
      CHECK ("description" IS NULL OR char_length("description") <= 500),
    CONSTRAINT "expenses_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "expenses_due_date_check"
      CHECK ("dueDate" IS NULL OR "dueDate" >= "invoiceDate"),
    -- Soporte completo o vacío.
    CONSTRAINT "expenses_attachment_check"
      CHECK (
        ("attachmentKey" IS NULL AND "attachmentMime" IS NULL AND "attachmentSize" IS NULL
          AND "attachmentSha256" IS NULL AND "attachmentName" IS NULL)
        OR ("attachmentKey" IS NOT NULL AND "attachmentMime" IS NOT NULL
          AND "attachmentSize" IS NOT NULL AND "attachmentSize" > 0
          AND "attachmentSha256" IS NOT NULL AND "attachmentName" IS NOT NULL)
      ),
    -- Anulación completa o vacía, con motivo de al menos 5 caracteres.
    CONSTRAINT "expenses_void_check"
      CHECK (
        ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
        OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL
          AND char_length(btrim("voidReason")) >= 5)
      )
);
-- Destino de la FK de expense_payments: sede y moneda del pago = las del gasto.
CREATE UNIQUE INDEX "expenses_tenant_id_location_currency_key"
  ON "expenses"("tenantId", "id", "locationId", "currency");
-- Lista de gastos de una sede por fecha de factura (y lado hijo de la FK de sede).
CREATE INDEX "expenses_tenant_location_invoice_idx"
  ON "expenses"("tenantId", "locationId", "invoiceDate" DESC, "id" DESC);

-- ---------------------------------------------------------------------------
-- expense_payments
-- ---------------------------------------------------------------------------
CREATE TABLE "expense_payments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "expenseId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "paidOn" DATE NOT NULL,
    "cashSessionId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,

    CONSTRAINT "expense_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "expense_payments_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El gasto es de la misma clínica, sede y moneda que el pago.
    CONSTRAINT "expense_payments_expense_fkey"
      FOREIGN KEY ("tenantId", "expenseId", "locationId", "currency")
      REFERENCES "expenses"("tenantId", "id", "locationId", "currency")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "expense_payments_cash_session_fkey"
      FOREIGN KEY ("tenantId", "cashSessionId") REFERENCES "cash_sessions"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "expense_payments_amount_check" CHECK ("amount" > 0),
    -- Una salida de caja es siempre efectivo.
    CONSTRAINT "expense_payments_cash_method_check"
      CHECK ("cashSessionId" IS NULL OR "method" = 'CASH'),
    CONSTRAINT "expense_payments_void_check"
      CHECK (
        ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
        OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL
          AND char_length(btrim("voidReason")) >= 5)
      )
);
-- Destino de la FK de cash_session_adjustments.
CREATE UNIQUE INDEX "expense_payments_tenant_id_key"
  ON "expense_payments"("tenantId", "id");
-- Pagos de un gasto (suma de lo pagado) y lado hijo de la FK compuesta.
CREATE INDEX "expense_payments_tenant_expense_idx"
  ON "expense_payments"("tenantId", "expenseId");
-- Salidas de una caja (su esperado y su informe) y lado hijo de la FK de caja.
CREATE INDEX "expense_payments_tenant_cash_session_idx"
  ON "expense_payments"("tenantId", "cashSessionId") WHERE "cashSessionId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
-- Alta con la hora del servidor en UTC (DX-226). Solo el INSERT: lo que venga
-- en "createdAt" (el reloj de la API) no cuenta.
CREATE FUNCTION public.dx_expense_server_created_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "expense_categories_server_created_at"
  BEFORE INSERT ON "expense_categories"
  FOR EACH ROW EXECUTE FUNCTION public.dx_expense_server_created_at();
CREATE TRIGGER "expenses_server_created_at"
  BEFORE INSERT ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION public.dx_expense_server_created_at();
CREATE TRIGGER "expense_payments_server_created_at"
  BEFORE INSERT ON "expense_payments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_expense_server_created_at();

-- expenses: anular no borra; el soporte y la anulación se fijan una vez.
CREATE FUNCTION public.dx_expense_guard() RETURNS trigger
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

  IF (NEW."id", NEW."tenantId", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."tenantId", OLD."createdById", OLD."createdAt")
  THEN
    RAISE EXCEPTION 'expenses es inalterable en su identidad: clínica, autor y alta no cambian (DX-274)'
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

  -- Anulación: vacía -> llena una vez, con la hora del servidor; no se deshace.
  IF OLD."voidedAt" IS NOT NULL THEN
    IF (NEW."voidedAt", NEW."voidedById", NEW."voidReason")
       IS DISTINCT FROM (OLD."voidedAt", OLD."voidedById", OLD."voidReason")
    THEN
      RAISE EXCEPTION 'Un gasto anulado no se anula de nuevo ni se reactiva (DX-274)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW."voidedAt" IS NOT NULL THEN
    NEW."voidedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "expenses_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION public.dx_expense_guard();
CREATE TRIGGER "expenses_no_truncate"
  BEFORE TRUNCATE ON "expenses"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_expense_guard();

-- expense_payments (copia de dx_payment_cash_session_guard, DX-027): un pago
-- con caja entra solo en una caja ABIERTA de su sede y su caja no cambia
-- nunca; sin DELETE; el único UPDATE es la anulación, una vez.
CREATE FUNCTION public.dx_expense_payment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
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
    RETURN NEW;
  END IF;

  -- UPDATE: solo la anulación (vacía -> llena), una vez; nada más cambia.
  IF OLD."voidedAt" IS NOT NULL OR NEW."voidedAt" IS NULL
     OR (NEW."id", NEW."tenantId", NEW."expenseId", NEW."locationId", NEW."amount",
         NEW."currency", NEW."method", NEW."paidOn", NEW."cashSessionId",
         NEW."createdById", NEW."createdAt")
        IS DISTINCT FROM
        (OLD."id", OLD."tenantId", OLD."expenseId", OLD."locationId", OLD."amount",
         OLD."currency", OLD."method", OLD."paidOn", OLD."cashSessionId",
         OLD."createdById", OLD."createdAt")
  THEN
    RAISE EXCEPTION 'expense_payments es inalterable: un pago solo se anula, una vez (DX-274)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."voidedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "expense_payments_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "expense_payments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_expense_payment_guard();
CREATE TRIGGER "expense_payments_no_truncate"
  BEFORE TRUNCATE ON "expense_payments"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_expense_payment_guard();

-- ---------------------------------------------------------------------------
-- RLS FORCE
-- ---------------------------------------------------------------------------
ALTER TABLE "expense_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "expenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "expense_payments" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "expense_categories"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON "expenses"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON "expense_payments"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "expense_categories" FORCE ROW LEVEL SECURITY;
ALTER TABLE "expenses" FORCE ROW LEVEL SECURITY;
ALTER TABLE "expense_payments" FORCE ROW LEVEL SECURITY;
