-- DX-027: caja por turno — apertura y cierre con arqueo por moneda y método,
-- por usuario y sede.
--
-- Cambios:
--   tenants   dos ajustes de caja de la clínica, con el comportamiento de hoy
--             por defecto: "cashRequireOpenSession" (false: se puede cobrar
--             en efectivo sin caja abierta) y "cashBlindClose" (false: el
--             cierre enseña el esperado mientras se cuenta).
--   cash_sessions   turno de caja de UN usuario en UNA sede: apertura (la
--                   hora la pone la BD), estado OPEN -> CLOSED (con cierre)
--                   y CLOSED -> OPEN solo con una reapertura registrada. Una
--                   sola abierta por (sede, usuario): índice único parcial.
--   cash_session_floats   fondo inicial por moneda (>= 0), solo en la
--                         transacción de la apertura; inalterable.
--   cash_session_closings   cada cierre (también los de después de una
--                           reapertura): quién, cuándo, si fue a ciegas,
--                           motivo de la diferencia (obligatorio si la hay) y
--                           la fecha de bloqueo sugerida (DX-091). Inalterable.
--   cash_session_closing_lines   arqueo por (moneda, método): fondo,
--                                esperado, contado (>= 0) y diferencia
--                                (CHECK = contado - esperado). Inalterable.
--   cash_session_adjustments   lo que llega DESPUÉS de cerrar una caja y no
--                              puede tocarla: la anulación de uno de sus
--                              abonos (VOID, < 0), un abono con fecha de un
--                              día ya cerrado (LATE_PAYMENT, > 0) o una
--                              corrección del ADMIN (CORRECTION, con motivo).
--                              Va a la caja abierta de quien lo hace en esa
--                              sede o, si no tiene, queda pendiente y se une a
--                              la siguiente que se abra en la sede (una vez).
--   cash_session_reopenings   reapertura de un cierre por un ADMIN, con
--                             motivo. Append-only.
--   payments."cashSessionId"   la caja (abierta) que recibió el abono: la de
--                              quien lo registra en su sede. Nunca cambia, y
--                              un trigger impide asociar un abono a una caja
--                              cerrada o de otra sede.
--
-- Importes DECIMAL(14,2) como "payments" con CHECK. FK COMPUESTAS por tenant
-- (SEC-004) dentro de cada CREATE TABLE (nacen vacías: el owner sin BYPASSRLS
-- no necesita ver filas, DX-134). El abono de un ajuste va por la clave
-- primaria de "payments" (que no tiene único (tenantId, id)) y el trigger
-- exige que sea de la misma clínica y sede, como hace payment_receipts.
--
-- Compatible hacia atrás: solo AÑADE (dos enums, seis tablas vacías, dos
-- columnas con DEFAULT constante en tenants, una columna NULL en payments con
-- su FK, índices, triggers y RLS). El código anterior no escribe
-- "cashSessionId" (queda NULL, permitido) y los ajustes por defecto son el
-- comportamiento de hoy.
--
-- Bloqueo: ADD COLUMN sin DEFAULT es solo catálogo; la FK nueva de payments
-- toma SHARE ROW EXCLUSIVE en payments y cash_sessions y valida las filas
-- existentes (todas NULL: un recorrido secuencial sin reescritura).
-- lock_timeout evita quedar encolado detrás de una transacción larga.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "CashSessionStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "CashAdjustmentKind" AS ENUM ('VOID', 'LATE_PAYMENT', 'CORRECTION');

-- ---------------------------------------------------------------------------
-- Ajustes de caja de la clínica (por defecto, el comportamiento de hoy)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenants"
  ADD COLUMN "cashRequireOpenSession" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cashBlindClose" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- cash_sessions
-- ---------------------------------------------------------------------------
CREATE TABLE "cash_sessions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "openedById" UUID NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedById" UUID,
    "reopenCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cash_sessions_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cash_sessions_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cash_sessions_notes_check"
      CHECK ("notes" IS NULL OR char_length(btrim("notes")) BETWEEN 1 AND 500),
    -- Abierta = sin cierre; cerrada = con hora y autor del cierre.
    CONSTRAINT "cash_sessions_closed_check"
      CHECK (("status" = 'OPEN') = ("closedAt" IS NULL)
             AND ("closedAt" IS NULL) = ("closedById" IS NULL)),
    CONSTRAINT "cash_sessions_reopen_count_check" CHECK ("reopenCount" >= 0)
);

-- Destino de las FK compuestas de floats, cierres, ajustes, reaperturas y
-- payments."cashSessionId".
CREATE UNIQUE INDEX "cash_sessions_tenant_id_key" ON "cash_sessions"("tenantId", "id");
-- Una sola caja abierta por (sede, usuario): abrir otra es 409. Sirve también
-- «mi caja abierta en esta sede» (al abrir, al cobrar, al anular).
CREATE UNIQUE INDEX "cash_sessions_open_key"
  ON "cash_sessions"("tenantId", "locationId", "openedById") WHERE "status" = 'OPEN';
-- Lista por sede y fecha (más recientes primero) y lado hijo de la FK de sede.
CREATE INDEX "cash_sessions_tenant_location_opened_idx"
  ON "cash_sessions"("tenantId", "locationId", "openedAt" DESC, "id" DESC);
-- Lista de toda la clínica por fecha.
CREATE INDEX "cash_sessions_tenant_opened_idx"
  ON "cash_sessions"("tenantId", "openedAt" DESC, "id" DESC);
-- Lista de recepción: solo las suyas.
CREATE INDEX "cash_sessions_tenant_user_opened_idx"
  ON "cash_sessions"("tenantId", "openedById", "openedAt" DESC, "id" DESC);

-- ---------------------------------------------------------------------------
-- cash_session_floats
-- ---------------------------------------------------------------------------
CREATE TABLE "cash_session_floats" (
    "tenantId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "cash_session_floats_pkey" PRIMARY KEY ("sessionId", "currency"),
    CONSTRAINT "cash_session_floats_session_fkey"
      FOREIGN KEY ("tenantId", "sessionId") REFERENCES "cash_sessions"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cash_session_floats_currency_fkey"
      FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cash_session_floats_amount_check" CHECK ("amount" >= 0)
);
CREATE INDEX "cash_session_floats_tenant_session_idx"
  ON "cash_session_floats"("tenantId", "sessionId");

-- ---------------------------------------------------------------------------
-- cash_session_closings
-- ---------------------------------------------------------------------------
CREATE TABLE "cash_session_closings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "closedById" UUID NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blind" BOOLEAN NOT NULL,
    "hasDifference" BOOLEAN NOT NULL,
    "differenceReason" TEXT,
    "notes" TEXT,
    "suggestedLockDate" DATE NOT NULL,

    CONSTRAINT "cash_session_closings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cash_session_closings_session_fkey"
      FOREIGN KEY ("tenantId", "sessionId") REFERENCES "cash_sessions"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cash_session_closings_sequence_check" CHECK ("sequence" >= 1),
    -- Una diferencia distinta de 0 exige motivo.
    CONSTRAINT "cash_session_closings_reason_check"
      CHECK (NOT "hasDifference" OR "differenceReason" IS NOT NULL),
    CONSTRAINT "cash_session_closings_reason_length_check"
      CHECK ("differenceReason" IS NULL OR char_length(btrim("differenceReason")) BETWEEN 3 AND 500),
    CONSTRAINT "cash_session_closings_notes_check"
      CHECK ("notes" IS NULL OR char_length(btrim("notes")) BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX "cash_session_closings_tenant_id_key"
  ON "cash_session_closings"("tenantId", "id");
-- Un cierre por vuelta (1 el primero, 2 tras la primera reapertura...).
CREATE UNIQUE INDEX "cash_session_closings_session_sequence_key"
  ON "cash_session_closings"("tenantId", "sessionId", "sequence");

-- ---------------------------------------------------------------------------
-- cash_session_closing_lines
-- ---------------------------------------------------------------------------
CREATE TABLE "cash_session_closing_lines" (
    "tenantId" UUID NOT NULL,
    "closingId" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "opening" DECIMAL(14,2) NOT NULL,
    "expected" DECIMAL(14,2) NOT NULL,
    "counted" DECIMAL(14,2) NOT NULL,
    "difference" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "cash_session_closing_lines_pkey" PRIMARY KEY ("closingId", "currency", "method"),
    CONSTRAINT "cash_session_closing_lines_closing_fkey"
      FOREIGN KEY ("tenantId", "closingId") REFERENCES "cash_session_closings"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cash_session_closing_lines_currency_fkey"
      FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El fondo solo existe en efectivo; lo contado nunca es negativo.
    CONSTRAINT "cash_session_closing_lines_opening_check"
      CHECK ("opening" >= 0 AND ("method" = 'CASH' OR "opening" = 0)),
    CONSTRAINT "cash_session_closing_lines_counted_check" CHECK ("counted" >= 0),
    CONSTRAINT "cash_session_closing_lines_difference_check"
      CHECK ("difference" = "counted" - "expected")
);
CREATE INDEX "cash_session_closing_lines_tenant_closing_idx"
  ON "cash_session_closing_lines"("tenantId", "closingId");

-- ---------------------------------------------------------------------------
-- cash_session_adjustments
-- ---------------------------------------------------------------------------
CREATE TABLE "cash_session_adjustments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "sessionId" UUID,
    "kind" "CashAdjustmentKind" NOT NULL,
    "paymentId" UUID,
    "originalSessionId" UUID,
    "currency" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_session_adjustments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cash_session_adjustments_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cash_session_adjustments_session_fkey"
      FOREIGN KEY ("tenantId", "sessionId") REFERENCES "cash_sessions"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cash_session_adjustments_original_fkey"
      FOREIGN KEY ("tenantId", "originalSessionId") REFERENCES "cash_sessions"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Por la clave primaria; la clínica y la sede las exige el trigger.
    CONSTRAINT "cash_session_adjustments_payment_fkey"
      FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cash_session_adjustments_currency_fkey"
      FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- VOID resta, LATE_PAYMENT suma, CORRECTION cualquiera menos 0 y con motivo.
    CONSTRAINT "cash_session_adjustments_kind_check"
      CHECK (
        ("kind" = 'VOID' AND "paymentId" IS NOT NULL AND "amount" < 0)
        OR ("kind" = 'LATE_PAYMENT' AND "paymentId" IS NOT NULL AND "amount" > 0)
        OR ("kind" = 'CORRECTION' AND "paymentId" IS NULL AND "amount" <> 0
            AND "originalSessionId" IS NOT NULL AND "reason" IS NOT NULL)
      ),
    CONSTRAINT "cash_session_adjustments_reason_check"
      CHECK ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 3 AND 300)
);
-- Una anulación y un abono tardío por abono, como mucho.
CREATE UNIQUE INDEX "cash_session_adjustments_payment_kind_key"
  ON "cash_session_adjustments"("paymentId", "kind") WHERE "paymentId" IS NOT NULL;
-- Ajustes de una caja (su esperado y su informe).
CREATE INDEX "cash_session_adjustments_tenant_session_idx"
  ON "cash_session_adjustments"("tenantId", "sessionId") WHERE "sessionId" IS NOT NULL;
-- Pendientes de una sede (se unen a la siguiente caja que se abra) y lado
-- hijo de la FK de sede.
CREATE INDEX "cash_session_adjustments_tenant_location_idx"
  ON "cash_session_adjustments"("tenantId", "locationId", "createdAt");
-- Ajustes que vienen de una caja ya cerrada (enlace al original).
CREATE INDEX "cash_session_adjustments_tenant_original_idx"
  ON "cash_session_adjustments"("tenantId", "originalSessionId") WHERE "originalSessionId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- cash_session_reopenings
-- ---------------------------------------------------------------------------
CREATE TABLE "cash_session_reopenings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "closingId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "reopenedById" UUID NOT NULL,
    "reopenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_session_reopenings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cash_session_reopenings_session_fkey"
      FOREIGN KEY ("tenantId", "sessionId") REFERENCES "cash_sessions"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cash_session_reopenings_closing_fkey"
      FOREIGN KEY ("tenantId", "closingId") REFERENCES "cash_session_closings"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cash_session_reopenings_sequence_check" CHECK ("sequence" >= 1),
    CONSTRAINT "cash_session_reopenings_reason_check"
      CHECK (char_length(btrim("reason")) BETWEEN 3 AND 300)
);
CREATE UNIQUE INDEX "cash_session_reopenings_session_sequence_key"
  ON "cash_session_reopenings"("tenantId", "sessionId", "sequence");
CREATE INDEX "cash_session_reopenings_tenant_closing_idx"
  ON "cash_session_reopenings"("tenantId", "closingId");

-- ---------------------------------------------------------------------------
-- payments."cashSessionId"
-- ---------------------------------------------------------------------------
ALTER TABLE "payments" ADD COLUMN "cashSessionId" UUID;
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_session_fkey"
  FOREIGN KEY ("tenantId", "cashSessionId") REFERENCES "cash_sessions"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- Abonos de una caja (esperado al cerrar) y lado hijo de la FK. Parcial: los
-- abonos sin caja (los de antes y los de sin «exigir caja») no ocupan índice.
CREATE INDEX "payments_tenant_cash_session_idx"
  ON "payments"("tenantId", "cashSessionId") WHERE "cashSessionId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Triggers. search_path fijo con pg_temp AL FINAL, tablas calificadas con
-- public. y pg_catalog.pg_roles calificado (SEC-032). Corren con el rol de la
-- app y su RLS: solo ven filas de la clínica del contexto. El superusuario
-- puede borrar (limpieza de las bases de test); el owner y la app, no.
-- ---------------------------------------------------------------------------

-- ¿Es un superusuario borrando? (limpieza de las bases de test)
CREATE FUNCTION public.dx_cash_is_superuser() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  );
$$;

-- cash_sessions: nace OPEN con la hora del servidor; solo cambian estado,
-- cierre y nº de reaperturas, y cada transición tiene que venir con su fila
-- (cierre o reapertura) en la misma transacción.
CREATE FUNCTION public.dx_cash_session_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF public.dx_cash_is_superuser() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'cash_sessions no admite %: una caja no se borra (DX-027)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW."openedAt" := CURRENT_TIMESTAMP;
    IF NEW."status" <> 'OPEN' OR NEW."reopenCount" <> 0 OR NEW."closedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Una caja nace abierta (DX-027)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."tenantId", NEW."locationId", NEW."openedById", NEW."openedAt", NEW."notes")
     IS DISTINCT FROM
     (OLD."id", OLD."tenantId", OLD."locationId", OLD."openedById", OLD."openedAt", OLD."notes")
  THEN
    RAISE EXCEPTION 'cash_sessions es inalterable: la apertura no se edita (DX-027)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD."status" = 'OPEN' AND NEW."status" = 'CLOSED' THEN
    NEW."closedAt" := CURRENT_TIMESTAMP;
    IF NEW."reopenCount" <> OLD."reopenCount" OR NOT EXISTS (
      SELECT 1 FROM public.cash_session_closings c
       WHERE c."tenantId" = NEW."tenantId" AND c."sessionId" = NEW."id"
         AND c."sequence" = NEW."reopenCount" + 1
         AND c."closedById" = NEW."closedById"
         AND c."closedAt" = CURRENT_TIMESTAMP::timestamp(3)
    ) THEN
      RAISE EXCEPTION 'Una caja solo se cierra con su arqueo (DX-027)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'CLOSED' AND NEW."status" = 'OPEN' THEN
    IF NEW."reopenCount" <> OLD."reopenCount" + 1 OR NOT EXISTS (
      SELECT 1 FROM public.cash_session_reopenings r
       WHERE r."tenantId" = NEW."tenantId" AND r."sessionId" = NEW."id"
         AND r."sequence" = NEW."reopenCount"
         AND r."reopenedAt" = CURRENT_TIMESTAMP::timestamp(3)
    ) THEN
      RAISE EXCEPTION 'Una caja cerrada solo se reabre con motivo, por un administrador (DX-027)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'cash_sessions es inalterable: un cierre no se edita; una corrección es un ajuste (DX-027)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "cash_sessions_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "cash_sessions"
  FOR EACH ROW EXECUTE FUNCTION public.dx_cash_session_guard();
CREATE TRIGGER "cash_sessions_no_truncate"
  BEFORE TRUNCATE ON "cash_sessions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_cash_session_guard();

-- Filas hijas inalterables: solo INSERT, y solo en la transacción que crea su
-- padre (la apertura para el fondo; el cierre para las líneas).
CREATE FUNCTION public.dx_cash_child_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND public.dx_cash_is_superuser() THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'cash_session_floats' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.cash_sessions s
         WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sessionId"
           AND s."status" = 'OPEN' AND s."reopenCount" = 0
           AND s."openedAt" = CURRENT_TIMESTAMP::timestamp(3)
      ) THEN
        RAISE EXCEPTION 'El fondo inicial solo se registra al abrir la caja (DX-027)'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF TG_TABLE_NAME = 'cash_session_closing_lines' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.cash_session_closings c
         WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."closingId"
           AND c."closedAt" = CURRENT_TIMESTAMP::timestamp(3)
      ) THEN
        RAISE EXCEPTION 'El arqueo solo se registra con su cierre (DX-027)'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% es inalterable: un cierre no se edita; una corrección es un ajuste (DX-027)', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "cash_session_floats_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "cash_session_floats"
  FOR EACH ROW EXECUTE FUNCTION public.dx_cash_child_guard();
CREATE TRIGGER "cash_session_floats_no_truncate"
  BEFORE TRUNCATE ON "cash_session_floats"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_cash_child_guard();
CREATE TRIGGER "cash_session_closing_lines_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "cash_session_closing_lines"
  FOR EACH ROW EXECUTE FUNCTION public.dx_cash_child_guard();
CREATE TRIGGER "cash_session_closing_lines_no_truncate"
  BEFORE TRUNCATE ON "cash_session_closing_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_cash_child_guard();

-- Cierres y reaperturas: append-only, con la hora del servidor; el cierre
-- solo de una caja abierta y con la vuelta que le toca, la reapertura solo de
-- una cerrada y de su último cierre.
CREATE FUNCTION public.dx_cash_event_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND public.dx_cash_is_superuser() THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% es inalterable: append-only (DX-027)', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_TABLE_NAME = 'cash_session_closings' THEN
    NEW."closedAt" := CURRENT_TIMESTAMP;
    IF NOT EXISTS (
      SELECT 1 FROM public.cash_sessions s
       WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sessionId"
         AND s."status" = 'OPEN' AND s."reopenCount" + 1 = NEW."sequence"
    ) THEN
      RAISE EXCEPTION 'Solo se cierra una caja abierta (DX-027)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    NEW."reopenedAt" := CURRENT_TIMESTAMP;
    IF NOT EXISTS (
      SELECT 1 FROM public.cash_sessions s
        JOIN public.cash_session_closings c
          ON c."tenantId" = s."tenantId" AND c."sessionId" = s."id"
       WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sessionId"
         AND s."status" = 'CLOSED' AND s."reopenCount" + 1 = NEW."sequence"
         AND c."id" = NEW."closingId" AND c."sequence" = NEW."sequence"
    ) THEN
      RAISE EXCEPTION 'Solo se reabre una caja cerrada, desde su último cierre (DX-027)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "cash_session_closings_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "cash_session_closings"
  FOR EACH ROW EXECUTE FUNCTION public.dx_cash_event_guard();
CREATE TRIGGER "cash_session_closings_no_truncate"
  BEFORE TRUNCATE ON "cash_session_closings"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_cash_event_guard();
CREATE TRIGGER "cash_session_reopenings_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "cash_session_reopenings"
  FOR EACH ROW EXECUTE FUNCTION public.dx_cash_event_guard();
CREATE TRIGGER "cash_session_reopenings_no_truncate"
  BEFORE TRUNCATE ON "cash_session_reopenings"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_cash_event_guard();

-- Ajustes: el abono es de la misma clínica y sede; la caja de destino está
-- abierta y es de la sede; la de origen, de la sede. Lo único que cambia
-- después es unir un ajuste pendiente a una caja abierta, una vez.
CREATE FUNCTION public.dx_cash_adjustment_guard() RETURNS trigger
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
           NEW."originalSessionId", NEW."currency", NEW."method", NEW."amount",
           NEW."reason", NEW."createdById", NEW."createdAt")
          IS DISTINCT FROM
          (OLD."id", OLD."tenantId", OLD."locationId", OLD."kind", OLD."paymentId",
           OLD."originalSessionId", OLD."currency", OLD."method", OLD."amount",
           OLD."reason", OLD."createdById", OLD."createdAt")
    THEN
      RAISE EXCEPTION 'cash_session_adjustments es inalterable: un ajuste pendiente solo se une una vez a una caja abierta (DX-027)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    NEW."createdAt" := CURRENT_TIMESTAMP;
    IF NEW."paymentId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.payments p
       WHERE p."id" = NEW."paymentId" AND p."tenantId" = NEW."tenantId"
         AND p."locationId" = NEW."locationId"
    ) THEN
      RAISE EXCEPTION 'El abono del ajuste no es de esta clínica y sede (DX-027)'
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

CREATE TRIGGER "cash_session_adjustments_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "cash_session_adjustments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_cash_adjustment_guard();
CREATE TRIGGER "cash_session_adjustments_no_truncate"
  BEFORE TRUNCATE ON "cash_session_adjustments"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_cash_adjustment_guard();

-- payments: un abono entra en una caja ABIERTA de su sede al registrarse, y
-- su caja no cambia nunca (una caja cerrada no gana ni pierde abonos).
CREATE FUNCTION public.dx_payment_cash_session_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."cashSessionId" IS DISTINCT FROM OLD."cashSessionId" THEN
      RAISE EXCEPTION 'La caja de un abono no cambia (DX-027)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."cashSessionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cash_sessions s
     WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."cashSessionId"
       AND s."locationId" = NEW."locationId" AND s."status" = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'Un abono solo entra en una caja abierta de su sede (DX-027)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_cash_session_guard"
  BEFORE INSERT OR UPDATE OF "cashSessionId" ON "payments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payment_cash_session_guard();

-- ---------------------------------------------------------------------------
-- RLS FORCE
-- ---------------------------------------------------------------------------
ALTER TABLE "cash_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_session_floats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_session_closings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_session_closing_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_session_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_session_reopenings" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "cash_sessions"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON "cash_session_floats"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON "cash_session_closings"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON "cash_session_closing_lines"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON "cash_session_adjustments"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON "cash_session_reopenings"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "cash_sessions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cash_session_floats" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cash_session_closings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cash_session_closing_lines" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cash_session_adjustments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cash_session_reopenings" FORCE ROW LEVEL SECURITY;
