-- DX-571: conciliación de transferencias y pagos móviles contra el extracto
-- del banco (CSV o Excel).
--
-- Tablas nuevas (todas por clínica: FK de tenant RESTRICT, FK compuestas
-- (tenantId, id), RLS ENABLE + FORCE con la política tenant_isolation):
--   bank_accounts                  la cuenta que recibe el dinero: nombre,
--                       moneda, tolerancia de importe (≥ 0) y el mapeo de
--                       columnas guardado del extracto de ese banco (JSON).
--   bank_account_payment_methods   qué medios del catálogo liquidan en la
--                       cuenta. Un medio, una sola cuenta (único por medio).
--                       Es configuración: se reemplaza al editar la cuenta.
--   bank_statement_imports         cada importación confirmada: SHA-256 del
--                       fichero, formato, contadores y período. Ni el
--                       fichero ni su nombre. Append-only.
--   bank_movements                 un movimiento de ENTRADA del extracto: solo
--                       fecha, referencia (y normalizada, DX-395), importe
--                       (> 0), moneda de la cuenta y descripción truncada a
--                       140. Clave natural única por cuenta (idempotencia).
--                       Append-only.
--   bank_reconciliation_matches    emparejado 1:1 movimiento ↔ abono, con
--                       historia: se cierra (endedAt) al deshacerlo o al
--                       anular el abono; nunca se borra. Únicos PARCIALES por
--                       movimiento y por abono entre los activos. Un trigger
--                       solo deja cerrar un emparejado abierto.
--
-- Sin FK hacia patients (el abono ya la tiene): no entra en la fusión de
-- pacientes ni en el deshacer de importaciones.
--
-- Aditiva: solo crea. Las tablas nacen vacías, así que las FK van en el
-- CREATE TABLE y los CHECK son válidos desde el principio.
-- Vuelta atrás: DROP TABLE de las cinco (en orden inverso), de las funciones
-- y de los dos tipos.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "BankReconciliationMatchKind" AS ENUM ('AUTO', 'MANUAL');
CREATE TYPE "BankReconciliationMatchEndReason" AS ENUM ('UNMATCHED', 'PAYMENT_VOIDED');

-- ---------------------------------------------------------------------------
-- bank_accounts
CREATE TABLE "bank_accounts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amountTolerance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "columnMapping" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bank_accounts_name_check"
      CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
    CONSTRAINT "bank_accounts_tolerance_check"
      CHECK ("amountTolerance" >= 0 AND "amountTolerance" <= 1000000),
    CONSTRAINT "bank_accounts_mapping_check"
      CHECK ("columnMapping" IS NULL OR jsonb_typeof("columnMapping") = 'object'),
    CONSTRAINT "bank_accounts_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bank_accounts_currency_fkey" FOREIGN KEY ("currency")
      REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bank_accounts_created_by_fkey" FOREIGN KEY ("createdById")
      REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "bank_accounts_tenant_name_key" ON "bank_accounts"("tenantId", "name");
-- Destino de las FK compuestas de las demás tablas.
CREATE UNIQUE INDEX "bank_accounts_tenant_id_key" ON "bank_accounts"("tenantId", "id");
CREATE INDEX "bank_accounts_currency_idx" ON "bank_accounts"("currency");
CREATE INDEX "bank_accounts_created_by_idx" ON "bank_accounts"("createdById");

-- ---------------------------------------------------------------------------
-- bank_account_payment_methods
CREATE TABLE "bank_account_payment_methods" (
    "tenantId" UUID NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "paymentMethodId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_account_payment_methods_pkey"
      PRIMARY KEY ("tenantId", "bankAccountId", "paymentMethodId"),
    CONSTRAINT "bank_account_payment_methods_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bank_account_payment_methods_account_fkey" FOREIGN KEY ("tenantId", "bankAccountId")
      REFERENCES "bank_accounts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bank_account_payment_methods_method_fkey" FOREIGN KEY ("tenantId", "paymentMethodId")
      REFERENCES "payment_methods"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Un medio liquida en UNA cuenta (y lado hijo de la FK al medio).
CREATE UNIQUE INDEX "bank_account_payment_methods_method_key"
  ON "bank_account_payment_methods"("tenantId", "paymentMethodId");

-- ---------------------------------------------------------------------------
-- bank_statement_imports
CREATE TABLE "bank_statement_imports" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "fileSha256" CHAR(64) NOT NULL,
    "fileFormat" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "creditRows" INTEGER NOT NULL,
    "createdRows" INTEGER NOT NULL,
    "duplicateRows" INTEGER NOT NULL,
    "ignoredRows" INTEGER NOT NULL,
    "errorRows" INTEGER NOT NULL,
    "matchedRows" INTEGER NOT NULL,
    "periodFrom" DATE,
    "periodTo" DATE,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_imports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bank_statement_imports_sha_check" CHECK ("fileSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "bank_statement_imports_format_check" CHECK ("fileFormat" IN ('CSV', 'XLSX')),
    CONSTRAINT "bank_statement_imports_counts_check" CHECK (
      "totalRows" >= 0 AND "creditRows" >= 0 AND "createdRows" >= 0
      AND "duplicateRows" >= 0 AND "ignoredRows" >= 0 AND "errorRows" >= 0
      AND "matchedRows" >= 0
      AND "createdRows" + "duplicateRows" = "creditRows"
    ),
    CONSTRAINT "bank_statement_imports_period_check" CHECK (
      ("periodFrom" IS NULL AND "periodTo" IS NULL)
      OR ("periodFrom" IS NOT NULL AND "periodTo" IS NOT NULL AND "periodFrom" <= "periodTo")
    ),
    CONSTRAINT "bank_statement_imports_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bank_statement_imports_account_fkey" FOREIGN KEY ("tenantId", "bankAccountId")
      REFERENCES "bank_accounts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bank_statement_imports_created_by_fkey" FOREIGN KEY ("createdById")
      REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Historial de la cuenta, de la más reciente a la más antigua (y lado hijo
-- de la FK a la cuenta).
CREATE INDEX "bank_statement_imports_account_created_idx"
  ON "bank_statement_imports"("tenantId", "bankAccountId", "createdAt" DESC);
CREATE UNIQUE INDEX "bank_statement_imports_tenant_id_key"
  ON "bank_statement_imports"("tenantId", "id");
CREATE INDEX "bank_statement_imports_created_by_idx" ON "bank_statement_imports"("createdById");

-- ---------------------------------------------------------------------------
-- bank_movements
CREATE TABLE "bank_movements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "importId" UUID NOT NULL,
    "bookedOn" DATE NOT NULL,
    "reference" TEXT,
    "referenceNormalized" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "description" TEXT,
    "naturalKey" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_movements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bank_movements_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "bank_movements_reference_check" CHECK (
      ("reference" IS NULL AND "referenceNormalized" IS NULL)
      OR (
        char_length(btrim("reference")) BETWEEN 1 AND 60
        AND "referenceNormalized" IS NOT NULL
        AND char_length("referenceNormalized") BETWEEN 1 AND 60
      )
    ),
    -- Datos de terceros: la descripción va truncada (SEC, DX-571).
    CONSTRAINT "bank_movements_description_check"
      CHECK ("description" IS NULL OR char_length("description") BETWEEN 1 AND 140),
    CONSTRAINT "bank_movements_key_check" CHECK ("naturalKey" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "bank_movements_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bank_movements_account_fkey" FOREIGN KEY ("tenantId", "bankAccountId")
      REFERENCES "bank_accounts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bank_movements_import_fkey" FOREIGN KEY ("tenantId", "importId")
      REFERENCES "bank_statement_imports"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bank_movements_currency_fkey" FOREIGN KEY ("currency")
      REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Idempotencia de la importación: el mismo movimiento no entra dos veces en
-- la cuenta (y lado hijo de la FK a la cuenta).
CREATE UNIQUE INDEX "bank_movements_account_key_key"
  ON "bank_movements"("tenantId", "bankAccountId", "naturalKey");
-- Las listas y el emparejado por período.
CREATE INDEX "bank_movements_account_booked_idx"
  ON "bank_movements"("tenantId", "bankAccountId", "bookedOn");
CREATE UNIQUE INDEX "bank_movements_tenant_id_key" ON "bank_movements"("tenantId", "id");
CREATE INDEX "bank_movements_import_idx" ON "bank_movements"("tenantId", "importId");
CREATE INDEX "bank_movements_currency_idx" ON "bank_movements"("currency");

-- ---------------------------------------------------------------------------
-- bank_reconciliation_matches
CREATE TABLE "bank_reconciliation_matches" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "movementId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    -- Copias del movimiento (cuenta y día) y del abono (paidAt) que pone el
    -- trigger al insertar: las listas y el emparejado leen los emparejados
    -- activos por RANGO (cuenta + día, o paidAt) y no por miles de ids.
    "bankAccountId" UUID NOT NULL,
    "bookedOn" DATE NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "kind" "BankReconciliationMatchKind" NOT NULL,
    "matchedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedById" UUID,
    "endReason" "BankReconciliationMatchEndReason",

    CONSTRAINT "bank_reconciliation_matches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bank_reconciliation_matches_end_check" CHECK (
      ("endedAt" IS NULL AND "endedById" IS NULL AND "endReason" IS NULL)
      OR ("endedAt" IS NOT NULL AND "endedById" IS NOT NULL AND "endReason" IS NOT NULL)
    ),
    CONSTRAINT "bank_reconciliation_matches_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bank_reconciliation_matches_movement_fkey" FOREIGN KEY ("tenantId", "movementId")
      REFERENCES "bank_movements"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bank_reconciliation_matches_payment_fkey" FOREIGN KEY ("tenantId", "paymentId")
      REFERENCES "payments"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bank_reconciliation_matches_matched_by_fkey" FOREIGN KEY ("matchedById")
      REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bank_reconciliation_matches_ended_by_fkey" FOREIGN KEY ("endedById")
      REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- 1:1 entre los ACTIVOS: un movimiento con un abono y un abono con un
-- movimiento. Parciales (Prisma no los expresa: viven solo aquí).
CREATE UNIQUE INDEX "bank_reconciliation_matches_movement_active_key"
  ON "bank_reconciliation_matches"("tenantId", "movementId") WHERE "endedAt" IS NULL;
CREATE UNIQUE INDEX "bank_reconciliation_matches_payment_active_key"
  ON "bank_reconciliation_matches"("tenantId", "paymentId") WHERE "endedAt" IS NULL;
-- Los activos de una cuenta en un período (listas, emparejado) y los activos
-- de los abonos de un rango de paidAt (abonos sin movimiento). Parciales.
CREATE INDEX "bank_reconciliation_matches_account_booked_active_idx"
  ON "bank_reconciliation_matches"("tenantId", "bankAccountId", "bookedOn") WHERE "endedAt" IS NULL;
CREATE INDEX "bank_reconciliation_matches_paid_active_idx"
  ON "bank_reconciliation_matches"("tenantId", "paidAt") WHERE "endedAt" IS NULL;
-- Lados hijos de las FK (la historia completa).
CREATE INDEX "bank_reconciliation_matches_movement_idx"
  ON "bank_reconciliation_matches"("tenantId", "movementId");
CREATE INDEX "bank_reconciliation_matches_payment_idx"
  ON "bank_reconciliation_matches"("tenantId", "paymentId");
CREATE INDEX "bank_reconciliation_matches_matched_by_idx"
  ON "bank_reconciliation_matches"("matchedById");
CREATE INDEX "bank_reconciliation_matches_ended_by_idx"
  ON "bank_reconciliation_matches"("endedById");

-- ---------------------------------------------------------------------------
-- RLS
ALTER TABLE "bank_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bank_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "bank_accounts"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "bank_account_payment_methods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bank_account_payment_methods" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "bank_account_payment_methods"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "bank_statement_imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bank_statement_imports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "bank_statement_imports"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "bank_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bank_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "bank_movements"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "bank_reconciliation_matches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bank_reconciliation_matches" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "bank_reconciliation_matches"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Permisos de la app
GRANT SELECT, INSERT, UPDATE ON "bank_accounts" TO dentalix_app;
REVOKE DELETE, TRUNCATE ON "bank_accounts" FROM dentalix_app;
-- Configuración que se reemplaza al editar la cuenta.
GRANT SELECT, INSERT, DELETE ON "bank_account_payment_methods" TO dentalix_app;
REVOKE UPDATE, TRUNCATE ON "bank_account_payment_methods" FROM dentalix_app;
-- Append-only.
GRANT SELECT, INSERT ON "bank_statement_imports" TO dentalix_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "bank_statement_imports" FROM dentalix_app;
GRANT SELECT, INSERT ON "bank_movements" TO dentalix_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "bank_movements" FROM dentalix_app;
-- Se inserta y se cierra (trigger); nunca se borra.
GRANT SELECT, INSERT, UPDATE ON "bank_reconciliation_matches" TO dentalix_app;
REVOKE DELETE, TRUNCATE ON "bank_reconciliation_matches" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- Guarda del emparejado: hora del servidor (DX-226) al crear y al cerrar; las
-- copias de cuenta, día y paidAt salen del movimiento y del abono (nunca del
-- cliente); en
-- un UPDATE solo se cierra un emparejado ABIERTO (endedAt, endedById,
-- endReason) y nada más cambia; un emparejado cerrado no se reabre. El
-- movimiento y el abono tienen que ser de la misma moneda y el abono, vivo.
-- search_path fijo con pg_temp AL FINAL y catálogo calificado (SEC-032).
CREATE FUNCTION public.dx_bank_match_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    IF NEW."endedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Un emparejado nace abierto (DX-571)'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT m."bankAccountId", m."bookedOn", p."paidAt"
      INTO NEW."bankAccountId", NEW."bookedOn", NEW."paidAt"
      FROM public.bank_movements m
      JOIN public.payments p
        ON p."tenantId" = m."tenantId" AND p."id" = NEW."paymentId"
     WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."movementId"
       AND p."deletedAt" IS NULL
       AND p."currency" = m."currency";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'El emparejado tiene que unir un movimiento y un abono vivo de la misma clínica y moneda (DX-571)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD."endedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Un emparejado cerrado no cambia (DX-571)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."movementId" IS DISTINCT FROM OLD."movementId"
     OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
     OR NEW."bankAccountId" IS DISTINCT FROM OLD."bankAccountId"
     OR NEW."bookedOn" IS DISTINCT FROM OLD."bookedOn"
     OR NEW."paidAt" IS DISTINCT FROM OLD."paidAt"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."matchedById" IS DISTINCT FROM OLD."matchedById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."endedAt" IS NULL THEN
    RAISE EXCEPTION 'Un emparejado solo se cierra (DX-571)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."endedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "bank_reconciliation_matches_guard"
  BEFORE INSERT OR UPDATE ON "bank_reconciliation_matches"
  FOR EACH ROW EXECUTE FUNCTION public.dx_bank_match_guard();

-- Las filas del extracto son append-only: hora del servidor (DX-226) al
-- insertar; UPDATE y DELETE rechazados siempre (salvo el superusuario de los
-- fixtures), además del REVOKE.
CREATE FUNCTION public.dx_bank_statement_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    RETURN NEW;
  END IF;
  IF public.dx_cash_is_superuser() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION '% no admite %: lo importado del extracto no cambia (DX-571)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "bank_statement_imports_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "bank_statement_imports"
  FOR EACH ROW EXECUTE FUNCTION public.dx_bank_statement_guard();
CREATE TRIGGER "bank_movements_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "bank_movements"
  FOR EACH ROW EXECUTE FUNCTION public.dx_bank_statement_guard();
