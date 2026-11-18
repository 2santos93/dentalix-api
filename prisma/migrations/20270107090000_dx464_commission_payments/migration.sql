-- DX-464: pago de la liquidación de honorarios (DX-018). Cada pago es de UNA
-- moneda y crea UN gasto de la sede (expenses + expense_payments); el estado
-- de la liquidación («Pagada parcialmente», «Pagada») se deriva de estas
-- tablas: las de DX-018 son append-only y no se tocan.
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   commission_payments          el pago: liquidación (y su profesional), sede,
--                                moneda, importe, medio, fecha, referencia y el
--                                gasto que lo refleja (FK COMPUESTA con la sede
--                                y la moneda del gasto). Se anula con motivo,
--                                una vez; nunca se borra.
--   commission_payment_lines     qué líneas de la liquidación cubre cada pago.
--                                Una línea solo puede estar en UN pago vivo
--                                (único parcial); al anular el pago se marca
--                                `voidedAt` y vuelve a estar pendiente.
--   commission_receipt_requests  el enlace de conformidad («recibido
--                                conforme») de un solo uso: hash del token, la
--                                foto del recibo y su SHA-256, caducidad y, al
--                                firmar, nombre, firma, IP, navegador y hora
--                                del servidor. Un enlace vivo y una firma por
--                                pago.
--
-- Sin columnas hacia patients (el recibo guarda solo iniciales en su foto):
-- dx_merge_patients no cambia.
--
-- FK sobre tablas con RLS FORCE (DX-134): van DENTRO de los CREATE TABLE
-- (nacen vacías). FK directa a tenants con RESTRICT. RLS ENABLE + FORCE con la
-- política NULLIF (DX-251). Funciones con search_path fijo y pg_temp al final
-- (SEC-032). La app no borra nada de esto (NO_APP_DELETE, DX-148).
--
-- Fecha: posterior a todo lo de main (DX-018 20270103…, DX-564 20270104…,
-- DX-566 20270105…).  Renumerada desde 20270105090000 por choque con DX-566.
--
-- Vuelta atrás: desplegar la API anterior y
--   DROP TABLE public."commission_receipt_requests";
--   DROP TABLE public."commission_payment_lines";
--   DROP TABLE public."commission_payments";
--   DROP FUNCTION public.dx_commission_receipt_request_guard();
--   DROP FUNCTION public.dx_commission_payment_line_guard();
--   DROP FUNCTION public.dx_commission_payment_guard();

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- commission_payments
-- ---------------------------------------------------------------------------
-- Inalterable salvo la anulación (una vez, con quién y motivo). La hora del
-- alta y la de la anulación las pone el servidor de BD (UTC). DELETE/TRUNCATE
-- solo un superusuario (purga y limpieza de test).
CREATE FUNCTION public.dx_commission_payment_guard() RETURNS trigger
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
    RAISE EXCEPTION 'commission_payments: un pago de honorarios no se borra, se anula (DX-464)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    IF NEW."voidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'commission_payments: un pago nace vivo (DX-464)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'commission_payments: un pago anulado no cambia (DX-464)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."settlementId" IS DISTINCT FROM OLD."settlementId"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."method" IS DISTINCT FROM OLD."method"
     OR NEW."paidOn" IS DISTINCT FROM OLD."paidOn"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."expenseId" IS DISTINCT FROM OLD."expenseId"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'commission_payments: solo se anula; el pago no se edita (DX-464)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."voidedAt" IS NOT NULL THEN
    NEW."voidedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE "commission_payments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "settlementId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "paidOn" DATE NOT NULL,
    "reference" TEXT,
    "expenseId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    CONSTRAINT "commission_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commission_payments_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- La liquidación, de la MISMA clínica y del MISMO profesional.
    CONSTRAINT "commission_payments_settlement_fkey"
      FOREIGN KEY ("tenantId", "settlementId", "userId")
      REFERENCES "commission_settlements"("tenantId", "id", "userId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El gasto, de la MISMA clínica, con la MISMA sede y la MISMA moneda.
    CONSTRAINT "commission_payments_expense_fkey"
      FOREIGN KEY ("tenantId", "expenseId", "locationId", "currency")
      REFERENCES "expenses"("tenantId", "id", "locationId", "currency")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "commission_payments_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_payments_voided_by_fkey"
      FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_payments_values_check" CHECK (
      "amount" > 0
      AND char_length("currency") = 3
      AND ("reference" IS NULL
           OR (char_length("reference") BETWEEN 1 AND 120 AND "reference" = btrim("reference")))
    ),
    -- La anulación va completa (hora, quién y motivo de 5 a 500) o no va.
    CONSTRAINT "commission_payments_void_check" CHECK (
      ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
      OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL
          AND char_length(btrim("voidReason")) BETWEEN 5 AND 500)
    )
);

-- Un gasto refleja un solo pago.
CREATE UNIQUE INDEX "commission_payments_tenant_expense_key"
  ON "commission_payments"("tenantId", "expenseId");
-- Destino de las FK de las líneas pagadas y de las conformidades.
CREATE UNIQUE INDEX "commission_payments_tenant_id_key"
  ON "commission_payments"("tenantId", "id");
-- Los pagos de una liquidación (y lado hijo de su FK).
CREATE INDEX "commission_payments_settlement_idx"
  ON "commission_payments"("tenantId", "settlementId", "userId");
CREATE INDEX "commission_payments_expense_idx"
  ON "commission_payments"("tenantId", "expenseId", "locationId", "currency");
CREATE INDEX "commission_payments_created_by_idx" ON "commission_payments"("createdById");
CREATE INDEX "commission_payments_voided_by_idx" ON "commission_payments"("voidedById");

CREATE TRIGGER "commission_payments_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "commission_payments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_commission_payment_guard();
CREATE TRIGGER "commission_payments_no_truncate"
  BEFORE TRUNCATE ON "commission_payments"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_commission_payment_guard();

ALTER TABLE "commission_payments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "commission_payments"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "commission_payments" FORCE ROW LEVEL SECURITY;
-- La app lee, crea y anula (UPDATE); nunca borra.
REVOKE DELETE, TRUNCATE ON "commission_payments" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- commission_payment_lines
-- ---------------------------------------------------------------------------
-- Al insertar: la línea es de la MISMA liquidación y de la MISMA moneda que el
-- pago. Después solo cambia `voidedAt` (una vez, y solo si el pago ya está
-- anulado). DELETE/TRUNCATE solo un superusuario.
CREATE FUNCTION public.dx_commission_payment_line_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ok boolean;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'commission_payment_lines: no se borran; se anula el pago (DX-464)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."voidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'commission_payment_lines: nace viva (DX-464)'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT EXISTS (
      SELECT 1
        FROM public."commission_payments" p
        JOIN public."commission_settlement_lines" l
          ON l."tenantId" = p."tenantId"
         AND l."settlementId" = p."settlementId"
         AND l."currency" = p."currency"
       WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."paymentId"
         AND l."id" = NEW."lineId" AND p."voidedAt" IS NULL
    ) INTO ok;
    IF NOT ok THEN
      RAISE EXCEPTION 'commission_payment_lines: la línea no es de la liquidación ni de la moneda del pago (DX-464)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
     OR NEW."lineId" IS DISTINCT FROM OLD."lineId"
     OR OLD."voidedAt" IS NOT NULL
     OR NEW."voidedAt" IS NULL THEN
    RAISE EXCEPTION 'commission_payment_lines: solo se anula, una vez (DX-464)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."commission_payments" p
     WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."paymentId"
       AND p."voidedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'commission_payment_lines: se anula con su pago (DX-464)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  NEW."voidedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TABLE "commission_payment_lines" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "voidedAt" TIMESTAMP(3),
    CONSTRAINT "commission_payment_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commission_payment_lines_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_payment_lines_payment_fkey"
      FOREIGN KEY ("tenantId", "paymentId") REFERENCES "commission_payments"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_payment_lines_line_fkey"
      FOREIGN KEY ("tenantId", "lineId") REFERENCES "commission_settlement_lines"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Una línea, en un solo pago vivo: pagar dos veces la misma es imposible.
CREATE UNIQUE INDEX "commission_payment_lines_live_line_key"
  ON "commission_payment_lines"("tenantId", "lineId")
  WHERE "voidedAt" IS NULL;
CREATE UNIQUE INDEX "commission_payment_lines_payment_line_key"
  ON "commission_payment_lines"("tenantId", "paymentId", "lineId");
-- Lado hijo de la FK a la línea.
CREATE INDEX "commission_payment_lines_line_idx"
  ON "commission_payment_lines"("tenantId", "lineId");

CREATE TRIGGER "commission_payment_lines_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "commission_payment_lines"
  FOR EACH ROW EXECUTE FUNCTION public.dx_commission_payment_line_guard();
CREATE TRIGGER "commission_payment_lines_no_truncate"
  BEFORE TRUNCATE ON "commission_payment_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_commission_payment_line_guard();

ALTER TABLE "commission_payment_lines" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "commission_payment_lines"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "commission_payment_lines" FORCE ROW LEVEL SECURITY;
REVOKE DELETE, TRUNCATE ON "commission_payment_lines" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- commission_receipt_requests
-- ---------------------------------------------------------------------------
-- El enlace y la foto del recibo no cambian. La apertura y la firma se
-- escriben una vez, con la hora del servidor; la revocación, una vez y solo
-- si no está firmado. DELETE/TRUNCATE solo un superusuario.
CREATE FUNCTION public.dx_commission_receipt_request_guard() RETURNS trigger
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
    RAISE EXCEPTION 'commission_receipt_requests: no se borra; se revoca (DX-464)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    IF NEW."openedAt" IS NOT NULL OR NEW."signedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'commission_receipt_requests: un enlace nace sin abrir, firmar ni revocar (DX-464)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."content" IS DISTINCT FROM OLD."content"
     OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'commission_receipt_requests: el enlace y el recibo no cambian (DX-464)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."signedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'commission_receipt_requests: un enlace firmado o revocado no cambia (DX-464)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."openedAt" IS NOT NULL AND NEW."openedAt" IS DISTINCT FROM OLD."openedAt" THEN
    RAISE EXCEPTION 'commission_receipt_requests: la apertura se apunta una vez (DX-464)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."openedAt" IS NULL AND NEW."openedAt" IS NOT NULL THEN
    NEW."openedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  END IF;
  IF NEW."signedAt" IS NOT NULL THEN
    NEW."signedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    IF NEW."signedAt" > NEW."expiresAt" THEN
      RAISE EXCEPTION 'commission_receipt_requests: el enlace caducó (DX-464)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."revokedAt" IS NOT NULL THEN
    NEW."revokedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE "commission_receipt_requests" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "signerName" TEXT,
    "signature" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "receiptHash" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,
    CONSTRAINT "commission_receipt_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commission_receipt_requests_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_receipt_requests_payment_fkey"
      FOREIGN KEY ("tenantId", "paymentId") REFERENCES "commission_payments"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_receipt_requests_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_receipt_requests_revoked_by_fkey"
      FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "commission_receipt_requests_values_check" CHECK (
      "tokenHash" ~ '^[0-9a-f]{64}$'
      AND "contentHash" ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof("content") = 'object'
    ),
    -- La firma va completa (hora, nombre, firma PNG ≤ 200 KB en base64 y la
    -- huella) o no va; nunca firmado y revocado a la vez.
    CONSTRAINT "commission_receipt_requests_signed_check" CHECK (
      ("signedAt" IS NULL AND "signerName" IS NULL AND "signature" IS NULL
        AND "receiptHash" IS NULL AND "ipAddress" IS NULL AND "userAgent" IS NULL)
      OR ("signedAt" IS NOT NULL
        AND char_length(btrim("signerName")) BETWEEN 2 AND 120
        AND char_length("signature") BETWEEN 1 AND 280000
        AND "receiptHash" ~ '^[0-9a-f]{64}$'
        AND "revokedAt" IS NULL)
    ),
    CONSTRAINT "commission_receipt_requests_revoked_check" CHECK (
      "revokedAt" IS NOT NULL OR "revokedById" IS NULL
    )
);

CREATE UNIQUE INDEX "commission_receipt_requests_token_hash_key"
  ON "commission_receipt_requests"("tokenHash");
-- Un enlace vivo por pago (pedir otro revoca el anterior antes de insertar).
CREATE UNIQUE INDEX "commission_receipt_requests_live_key"
  ON "commission_receipt_requests"("tenantId", "paymentId")
  WHERE "signedAt" IS NULL AND "revokedAt" IS NULL;
-- Una conformidad firmada por pago.
CREATE UNIQUE INDEX "commission_receipt_requests_signed_key"
  ON "commission_receipt_requests"("tenantId", "paymentId")
  WHERE "signedAt" IS NOT NULL;
-- Lados hijos de las FK.
CREATE INDEX "commission_receipt_requests_payment_idx"
  ON "commission_receipt_requests"("tenantId", "paymentId");
CREATE INDEX "commission_receipt_requests_created_by_idx"
  ON "commission_receipt_requests"("createdById");
CREATE INDEX "commission_receipt_requests_revoked_by_idx"
  ON "commission_receipt_requests"("revokedById");

CREATE TRIGGER "commission_receipt_requests_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "commission_receipt_requests"
  FOR EACH ROW EXECUTE FUNCTION public.dx_commission_receipt_request_guard();
CREATE TRIGGER "commission_receipt_requests_no_truncate"
  BEFORE TRUNCATE ON "commission_receipt_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_commission_receipt_request_guard();

ALTER TABLE "commission_receipt_requests" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "commission_receipt_requests"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "commission_receipt_requests" FORCE ROW LEVEL SECURITY;
REVOKE DELETE, TRUNCATE ON "commission_receipt_requests" FROM dentalix_app;
