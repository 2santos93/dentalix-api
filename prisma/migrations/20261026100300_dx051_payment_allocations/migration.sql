-- DX-051: imputación de abonos a ítems del plan.
--
-- Cambios:
--   payment_plan_amounts            BASE de cada abono a un plan: el abono
--                                   convertido UNA vez a la moneda del plan con
--                                   la tasa de su "paidOn" (R3). Sin fila = abono
--                                   aún sin tasa, que no se imputa. "manual" =
--                                   abono fijado a mano por un ADMIN (el reparto
--                                   automático no lo usa como donante).
--   payment_allocations             imputación VIVA (abono, ítem, importe en la
--                                   moneda del plan; AUTO o MANUAL). Anular,
--                                   reasignar o liberar borra o reduce filas.
--   plan_allocation_rebalance_requests
--                                   cola de solo-inserción de planes con reparto
--                                   pendiente: varias filas por plan son normales;
--                                   el reparto borra solo los ids que leyó.
--   payment_allocation_movements    historial de solo-inserción: cada cambio de
--                                   una imputación deja su delta en céntimos y su
--                                   causa (AUTO, MANUAL, RELEASE o VOID), para
--                                   reconstruir lo imputado a cualquier fecha
--                                   (DX-018).
--
-- Reglas en la BD:
--   * FK COMPUESTAS por tenant (SEC-004) dentro del CREATE TABLE (tablas
--     vacías; DX-134): la base solo existe para un abono A UN PLAN
--     (payments_tenant_id_plan_key, 20261026100100); una imputación necesita la
--     base de su abono y su ítem es del MISMO plan que el abono
--     (treatment_plan_items_tenant_id_plan_key, 20261026100200). ON UPDATE
--     RESTRICT: mover un abono o un ítem de plan con imputaciones queda
--     prohibido en vez de arrastrarlas. La cola cae con su plan (ON DELETE
--     CASCADE: fila derivada, como membership_locations o los vínculos de
--     visitas), así el borrado duro de planes en la limpieza de tests no choca.
--   * payment_plan_amounts: la base no cambia nunca; solo "manual" (GRANT por
--     columna y trigger). Sin DELETE salvo superusuario.
--   * payment_allocations: un UPDATE solo cambia "amount" ("updatedAt" lo pone
--     el trigger en UTC). Red de R7 (trigger `payment_allocations_guard`): Σ
--     de un ítem <= su facturable y Σ de un abono <= su base, con el abono vivo
--     y la base en la moneda vigente del plan. Bajar un importe no comprueba
--     nada más (es lo que hace la liberación).
--   * Liberación (R8) en triggers AFTER de treatment_plan_items y
--     treatment_plans: si baja el facturable de un ítem (precio, descuento,
--     estado, retiro) o el plan deja de cobrarse o se retira, lo que sobra se
--     quita primero de las imputaciones AUTO y después de las MANUAL, de la más
--     reciente a la más antigua; y el plan queda encolado. Así los seis caminos
--     que cambian lo facturable (editar, quitar, descuento en bloque, estado del
--     plan, alternativas, anular un cargo por inasistencia) liberan en su
--     transacción sin tocar sus repositorios.
--   * Guarda de tenant: con la RLS activa y sin `app.current_tenant` de la
--     clínica de la fila, liberar o encolar falla en vez de borrar 0 filas en
--     silencio (la RLS escondería las imputaciones). Un superusuario (tests) no se
--     ve afectado. Una migración del owner que cambie esas columnas debe fijar
--     `app.current_tenant` por clínica: quitar FORCE solo de esta tabla no
--     basta, porque los mismos triggers insertan también en la cola y en el
--     historial, que siguen con FORCE.
--   * payment_allocation_movements la escribe un trigger AFTER de
--     payment_allocations con la causa que fija la transacción en el GUC local
--     `app.allocation_cause` (por defecto AUTO). Sin UPDATE ni DELETE salvo el
--     DELETE de un superusuario (limpieza de tests, como dx_cash_is_superuser).
--   * "createdAt"/"requestedAt"/"at" los pone la BD en UTC (DX-226).
--
-- Orden de bloqueo (R6), para quien escriba imputaciones o bases: plan FOR
-- SHARE -> bases FOR UPDATE ORDER BY "paymentId" -> ítems FOR UPDATE ORDER BY
-- id -> sumas en una sentencia posterior. El guard bloquea base e ítem (no-op
-- si el llamante ya los tiene). La liberación de un ítem solo toca el ítem que
-- su transacción ya tiene bloqueado (y las filas de imputación de ese ítem).
--
-- Compatible hacia atrás: AÑADE cuatro tablas vacías, un enum, funciones y
-- triggers. El código anterior no conoce las tablas; los triggers nuevos de
-- treatment_plan_items y treatment_plans solo encolan (y no liberan nada,
-- porque no hay imputaciones) mientras no exista el código del ticket.
--
-- Grants: ALTER DEFAULT PRIVILEGES da a dentalix_app SELECT, INSERT, UPDATE y
-- DELETE en las tablas nuevas (y USAGE en la secuencia); aquí se recortan.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "PaymentAllocationSource" AS ENUM ('AUTO', 'MANUAL');

-- uuid v7 (orden temporal) para las filas que crea un trigger, donde no llega
-- el @default(uuid(7)) del cliente de Prisma: 48 bits de milisegundos Unix +
-- versión 7 + variante RFC 4122 sobre bytes aleatorios. Los milisegundos son
-- los del inicio de la transacción en UTC (DX-226: ninguna función usa la hora
-- de la sesión); dentro de una misma transacción el orden lo da "at" + id.
CREATE FUNCTION public.dx051_uuid_v7() RETURNS uuid
  LANGUAGE sql VOLATILE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.encode(
    pg_catalog.set_bit(
      pg_catalog.set_bit(
        overlay(
          pg_catalog.uuid_send(pg_catalog.gen_random_uuid())
          PLACING substring(
            pg_catalog.int8send(
              pg_catalog.floor(
                pg_catalog.date_part('epoch', pg_catalog.timezone('UTC', pg_catalog.now())) * 1000
              )::bigint
            ) FROM 3
          )
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
$$;

-- ---------------------------------------------------------------------------
-- payment_plan_amounts
-- ---------------------------------------------------------------------------
CREATE TABLE "payment_plan_amounts" (
    "paymentId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "treatmentPlanId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "rateDate" DATE NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_plan_amounts_pkey" PRIMARY KEY ("paymentId"),
    CONSTRAINT "payment_plan_amounts_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Solo abonos a planes, de la MISMA clínica y de ESE plan.
    CONSTRAINT "payment_plan_amounts_payment_fkey"
      FOREIGN KEY ("tenantId", "paymentId", "treatmentPlanId")
      REFERENCES "payments"("tenantId", "id", "treatmentPlanId")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "payment_plan_amounts_currency_fkey"
      FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_plan_amounts_amount_check" CHECK ("amount" > 0)
);
-- Destino de la FK de payment_allocations.
CREATE UNIQUE INDEX "payment_plan_amounts_tenant_payment_key"
  ON "payment_plan_amounts"("tenantId", "paymentId");
-- Bases de los abonos de un plan (reparto, saldo por ítem).
CREATE INDEX "payment_plan_amounts_tenant_plan_idx"
  ON "payment_plan_amounts"("tenantId", "treatmentPlanId");
-- Lado hijo de la FK de moneda.
CREATE INDEX "payment_plan_amounts_currency_idx"
  ON "payment_plan_amounts"("currency");

-- ---------------------------------------------------------------------------
-- payment_allocations
-- ---------------------------------------------------------------------------
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "treatmentPlanId" UUID NOT NULL,
    "treatmentPlanItemId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "source" "PaymentAllocationSource" NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_allocations_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Sin base no se imputa (un abono a un saldo migrado nunca tiene base).
    CONSTRAINT "payment_allocations_base_fkey"
      FOREIGN KEY ("tenantId", "paymentId")
      REFERENCES "payment_plan_amounts"("tenantId", "paymentId")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "payment_allocations_payment_fkey"
      FOREIGN KEY ("tenantId", "paymentId", "treatmentPlanId")
      REFERENCES "payments"("tenantId", "id", "treatmentPlanId")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    -- El ítem es del plan del abono.
    CONSTRAINT "payment_allocations_item_fkey"
      FOREIGN KEY ("tenantId", "treatmentPlanItemId", "treatmentPlanId")
      REFERENCES "treatment_plan_items"("tenantId", "id", "planId")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "payment_allocations_plan_fkey"
      FOREIGN KEY ("tenantId", "treatmentPlanId")
      REFERENCES "treatment_plans"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "payment_allocations_amount_check" CHECK ("amount" > 0)
);
-- Una fila por (abono, ítem); y lado hijo de las FK a la base y al abono.
CREATE UNIQUE INDEX "payment_allocations_tenant_payment_item_key"
  ON "payment_allocations"("tenantId", "paymentId", "treatmentPlanItemId");
-- Imputaciones de un ítem (guard, liberación) y lado hijo de la FK al ítem.
CREATE INDEX "payment_allocations_tenant_item_idx"
  ON "payment_allocations"("tenantId", "treatmentPlanItemId");
-- Imputaciones de un plan (saldo por ítem, liberación del plan).
CREATE INDEX "payment_allocations_tenant_plan_idx"
  ON "payment_allocations"("tenantId", "treatmentPlanId");

-- ---------------------------------------------------------------------------
-- plan_allocation_rebalance_requests (cola de solo-inserción)
-- ---------------------------------------------------------------------------
CREATE TABLE "plan_allocation_rebalance_requests" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "treatmentPlanId" UUID NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_allocation_rebalance_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plan_allocation_rebalance_requests_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "plan_allocation_rebalance_requests_plan_fkey"
      FOREIGN KEY ("tenantId", "treatmentPlanId")
      REFERENCES "treatment_plans"("tenantId", "id")
      ON DELETE CASCADE ON UPDATE RESTRICT
);
-- NO único: cada escritor inserta su fila sin ON CONFLICT ni esperas.
CREATE INDEX "plan_allocation_rebalance_requests_tenant_plan_idx"
  ON "plan_allocation_rebalance_requests"("tenantId", "treatmentPlanId");

-- ---------------------------------------------------------------------------
-- payment_allocation_movements (historial de solo-inserción)
-- ---------------------------------------------------------------------------
CREATE TABLE "payment_allocation_movements" (
    "id" UUID NOT NULL DEFAULT public.dx051_uuid_v7(),
    "tenantId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "treatmentPlanId" UUID NOT NULL,
    "treatmentPlanItemId" UUID NOT NULL,
    "deltaCents" BIGINT NOT NULL,
    "cause" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocation_movements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_allocation_movements_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_allocation_movements_payment_fkey"
      FOREIGN KEY ("tenantId", "paymentId", "treatmentPlanId")
      REFERENCES "payments"("tenantId", "id", "treatmentPlanId")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "payment_allocation_movements_item_fkey"
      FOREIGN KEY ("tenantId", "treatmentPlanItemId", "treatmentPlanId")
      REFERENCES "treatment_plan_items"("tenantId", "id", "planId")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "payment_allocation_movements_delta_check" CHECK ("deltaCents" <> 0),
    CONSTRAINT "payment_allocation_movements_cause_check"
      CHECK ("cause" IN ('AUTO', 'MANUAL', 'RELEASE', 'VOID'))
);
-- Historial de un abono (y lado hijo de la FK al abono).
CREATE INDEX "payment_allocation_movements_tenant_payment_idx"
  ON "payment_allocation_movements"("tenantId", "paymentId", "treatmentPlanId");
-- Historial de un ítem por fecha (DX-018) y lado hijo de la FK al ítem.
CREATE INDEX "payment_allocation_movements_tenant_item_at_idx"
  ON "payment_allocation_movements"("tenantId", "treatmentPlanItemId", "treatmentPlanId", "at");

-- ---------------------------------------------------------------------------
-- Hora del servidor en UTC (DX-226). Solo el INSERT: lo que mande la API no
-- cuenta.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx051_server_created_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.dx051_allocation_server_created_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  NEW."updatedAt" := NEW."createdAt";
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.dx051_rebalance_request_server_time() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."requestedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.dx051_movement_server_time() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."at" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_plan_amounts_server_created_at"
  BEFORE INSERT ON "payment_plan_amounts"
  FOR EACH ROW EXECUTE FUNCTION public.dx051_server_created_at();
CREATE TRIGGER "payment_allocations_server_created_at"
  BEFORE INSERT ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION public.dx051_allocation_server_created_at();
CREATE TRIGGER "plan_allocation_rebalance_requests_server_created_at"
  BEFORE INSERT ON "plan_allocation_rebalance_requests"
  FOR EACH ROW EXECUTE FUNCTION public.dx051_rebalance_request_server_time();
CREATE TRIGGER "payment_allocation_movements_server_created_at"
  BEFORE INSERT ON "payment_allocation_movements"
  FOR EACH ROW EXECUTE FUNCTION public.dx051_movement_server_time();

-- ---------------------------------------------------------------------------
-- payment_plan_amounts: la base no cambia; solo "manual". Sin DELETE salvo
-- superusuario (limpieza de tests).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.payment_plan_amounts_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF public.dx_cash_is_superuser() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'payment_plan_amounts no admite %: la base de un abono no se borra (DX-051)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - 'manual') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'manual') THEN
    RAISE EXCEPTION 'La base de un abono no cambia: solo se fija o desfija a mano (DX-051)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_plan_amounts_guard"
  BEFORE UPDATE OR DELETE ON "payment_plan_amounts"
  FOR EACH ROW EXECUTE FUNCTION public.payment_plan_amounts_guard();
CREATE TRIGGER "payment_plan_amounts_no_truncate"
  BEFORE TRUNCATE ON "payment_plan_amounts"
  FOR EACH STATEMENT EXECUTE FUNCTION public.payment_plan_amounts_guard();

-- ---------------------------------------------------------------------------
-- payment_allocations: red de R7.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.payment_allocations_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_base_amount numeric;
  v_base_currency text;
  v_plan_currency text;
  v_billable numeric;
  v_item_total numeric;
  v_payment_total numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (pg_catalog.to_jsonb(NEW) - ARRAY['amount', 'updatedAt'])
       IS DISTINCT FROM
       (pg_catalog.to_jsonb(OLD) - ARRAY['amount', 'updatedAt']) THEN
      RAISE EXCEPTION 'Una imputación solo cambia de importe (DX-051)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW."updatedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    -- Bajar (o dejar igual) un importe no puede romper ningún tope.
    IF NEW."amount" <= OLD."amount" THEN
      RETURN NEW;
    END IF;
  END IF;

  -- 1. Bloqueos (no-op si el llamante ya los tiene, R6): base y después ítem.
  PERFORM 1 FROM public."payment_plan_amounts" b
   WHERE b."tenantId" = NEW."tenantId" AND b."paymentId" = NEW."paymentId"
   FOR UPDATE;
  PERFORM 1 FROM public."treatment_plan_items" i
   WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."treatmentPlanItemId"
   FOR UPDATE;

  -- 2. Comprobaciones en sentencias POSTERIORES al bloqueo (ven lo último
  -- confirmado por quien tenía el bloqueo).
  IF EXISTS (
    SELECT 1 FROM public."payments" p
     WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."paymentId"
       AND p."deletedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'El abono está anulado (DX-051)' USING ERRCODE = 'check_violation';
  END IF;

  -- Sin base o sin plan visibles, deja que las FK respondan.
  SELECT b."amount", b."currency" INTO v_base_amount, v_base_currency
    FROM public."payment_plan_amounts" b
   WHERE b."tenantId" = NEW."tenantId" AND b."paymentId" = NEW."paymentId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  SELECT tp."currency" INTO v_plan_currency
    FROM public."treatment_plans" tp
   WHERE tp."tenantId" = NEW."tenantId" AND tp."id" = NEW."treatmentPlanId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF v_base_currency IS DISTINCT FROM v_plan_currency THEN
    RAISE EXCEPTION 'La moneda del plan cambió (DX-051)' USING ERRCODE = 'check_violation';
  END IF;

  v_billable := public.dx051_item_billable(NEW."tenantId", NEW."treatmentPlanItemId");
  SELECT coalesce(sum(a."amount"), 0) INTO v_item_total
    FROM public."payment_allocations" a
   WHERE a."tenantId" = NEW."tenantId"
     AND a."treatmentPlanItemId" = NEW."treatmentPlanItemId"
     AND a."id" <> NEW."id";
  IF v_item_total + NEW."amount" > v_billable THEN
    RAISE EXCEPTION 'La imputación supera el saldo del ítem (DX-051)' USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(sum(a."amount"), 0) INTO v_payment_total
    FROM public."payment_allocations" a
   WHERE a."tenantId" = NEW."tenantId"
     AND a."paymentId" = NEW."paymentId"
     AND a."id" <> NEW."id";
  IF v_payment_total + NEW."amount" > v_base_amount THEN
    RAISE EXCEPTION 'La imputación supera el importe del abono (DX-051)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Facturable de un ítem (misma regla que GetPlanBalanceUseCase.billable):
-- price − discount si el ítem está vivo y ACCEPTED o DONE y su plan está vivo y
-- se cobra (no REJECTED ni CANCELLED); si no, 0. 0 también si no se ve.
CREATE FUNCTION public.dx051_item_billable(p_tenant uuid, p_item uuid) RETURNS numeric
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce((
    SELECT CASE
             WHEN i."deletedAt" IS NULL
              AND i."status" IN ('ACCEPTED', 'DONE')
              AND tp."deletedAt" IS NULL
              AND tp."status" NOT IN ('REJECTED', 'CANCELLED')
             THEN i."price" - i."discount"
             ELSE 0
           END
      FROM public."treatment_plan_items" i
      JOIN public."treatment_plans" tp
        ON tp."tenantId" = i."tenantId" AND tp."id" = i."planId"
     WHERE i."tenantId" = p_tenant AND i."id" = p_item
  ), 0);
$$;

CREATE TRIGGER "payment_allocations_guard"
  BEFORE INSERT OR UPDATE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION public.payment_allocations_guard();

-- ---------------------------------------------------------------------------
-- payment_allocation_movements: historial de cada cambio de una imputación.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.payment_allocations_movements() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_row public."payment_allocations";
  v_delta bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_row := NEW;
    v_delta := pg_catalog.round(NEW."amount" * 100)::bigint;
  ELSIF TG_OP = 'UPDATE' THEN
    v_row := NEW;
    v_delta := pg_catalog.round((NEW."amount" - OLD."amount") * 100)::bigint;
  ELSE
    v_row := OLD;
    v_delta := -pg_catalog.round(OLD."amount" * 100)::bigint;
  END IF;
  IF v_delta = 0 THEN
    RETURN NULL;
  END IF;
  INSERT INTO public."payment_allocation_movements"
    ("tenantId", "paymentId", "treatmentPlanId", "treatmentPlanItemId", "deltaCents", "cause")
  VALUES
    (v_row."tenantId", v_row."paymentId", v_row."treatmentPlanId", v_row."treatmentPlanItemId",
     v_delta,
     coalesce(NULLIF(pg_catalog.current_setting('app.allocation_cause', true), ''), 'AUTO'));
  RETURN NULL;
END;
$$;

CREATE TRIGGER "payment_allocations_movements"
  AFTER INSERT OR UPDATE OR DELETE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION public.payment_allocations_movements();

-- Solo-inserción: sin UPDATE; DELETE solo de un superusuario.
CREATE FUNCTION public.payment_allocation_movements_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND public.dx_cash_is_superuser() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'payment_allocation_movements es un historial: no admite % (DX-051)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "payment_allocation_movements_append_only"
  BEFORE UPDATE OR DELETE ON "payment_allocation_movements"
  FOR EACH ROW EXECUTE FUNCTION public.payment_allocation_movements_append_only();
CREATE TRIGGER "payment_allocation_movements_no_truncate"
  BEFORE TRUNCATE ON "payment_allocation_movements"
  FOR EACH STATEMENT EXECUTE FUNCTION public.payment_allocation_movements_append_only();

-- ---------------------------------------------------------------------------
-- Liberación y encolado.
-- ---------------------------------------------------------------------------
-- Guarda de tenant: con la RLS activa, sin la clínica de la fila en
-- `app.current_tenant` la liberación borraría 0 filas en silencio.
CREATE FUNCTION public.dx051_require_tenant(p_tenant uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_catalog.row_security_active('public.payment_allocations')
     AND NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid
         IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'Falta el tenant de la sesión (DX-051)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- Quita lo que las imputaciones de un ítem superen su facturable: primero de
-- las AUTO y después de las MANUAL; en cada grupo, de la más reciente a la más
-- antigua (paidAt, createdAt e id del abono/imputación, descendentes). Borra
-- filas enteras y reduce la última. Solo toca imputaciones de ESE ítem. La
-- causa de los movimientos es RELEASE mientras dura; después se restaura la de
-- la transacción.
CREATE FUNCTION public.dx_release_item_allocations(p_tenant uuid, p_item uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_cause text := pg_catalog.current_setting('app.allocation_cause', true);
  v_excess numeric;
  r record;
BEGIN
  PERFORM public.dx051_require_tenant(p_tenant);
  SELECT coalesce(sum(a."amount"), 0) - public.dx051_item_billable(p_tenant, p_item)
    INTO v_excess
    FROM public."payment_allocations" a
   WHERE a."tenantId" = p_tenant AND a."treatmentPlanItemId" = p_item;
  IF v_excess <= 0 THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.set_config('app.allocation_cause', 'RELEASE', true);
  FOR r IN
    SELECT a."id", a."amount"
      FROM public."payment_allocations" a
      JOIN public."payments" p
        ON p."tenantId" = a."tenantId" AND p."id" = a."paymentId"
     WHERE a."tenantId" = p_tenant AND a."treatmentPlanItemId" = p_item
     ORDER BY CASE a."source" WHEN 'AUTO' THEN 0 ELSE 1 END,
              p."paidAt" DESC, p."createdAt" DESC, a."id" DESC
       FOR UPDATE OF a
  LOOP
    EXIT WHEN v_excess <= 0;
    IF r."amount" <= v_excess THEN
      DELETE FROM public."payment_allocations" WHERE "id" = r."id";
      v_excess := v_excess - r."amount";
    ELSE
      UPDATE public."payment_allocations"
         SET "amount" = "amount" - v_excess
       WHERE "id" = r."id";
      v_excess := 0;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('app.allocation_cause', coalesce(v_prev_cause, ''), true);
END;
$$;

-- Ítem: alta, o cambio de precio, descuento, estado, retiro o fecha de
-- realización (Prisma reenvía campos sin cambios: sin cambio real no hace
-- nada).
CREATE FUNCTION public.treatment_plan_items_allocations() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW."price", NEW."discount", NEW."status", NEW."deletedAt", NEW."completedAt")
         IS NOT DISTINCT FROM
         (OLD."price", OLD."discount", OLD."status", OLD."deletedAt", OLD."completedAt") THEN
    RETURN NULL;
  END IF;
  PERFORM public.dx051_require_tenant(NEW."tenantId");
  IF TG_OP = 'UPDATE' THEN
    PERFORM public.dx_release_item_allocations(NEW."tenantId", NEW."id");
  END IF;
  INSERT INTO public."plan_allocation_rebalance_requests" ("tenantId", "treatmentPlanId")
  VALUES (NEW."tenantId", NEW."planId");
  RETURN NULL;
END;
$$;

CREATE TRIGGER "treatment_plan_items_allocations"
  AFTER INSERT OR UPDATE OF "price", "discount", "status", "deletedAt", "completedAt"
  ON "treatment_plan_items"
  FOR EACH ROW EXECUTE FUNCTION public.treatment_plan_items_allocations();

-- Plan: si deja de cobrarse (REJECTED, CANCELLED) o se retira, libera las
-- imputaciones de todos sus ítems (excepción documentada de R6: solo con el
-- bloqueo de la fila del plan, porque todo otro escritor de imputaciones
-- necesita antes el plan FOR SHARE); en todo caso encola el plan.
CREATE FUNCTION public.treatment_plans_allocations() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r record;
BEGIN
  IF (NEW."status", NEW."deletedAt") IS NOT DISTINCT FROM (OLD."status", OLD."deletedAt") THEN
    RETURN NULL;
  END IF;
  PERFORM public.dx051_require_tenant(NEW."tenantId");
  IF NEW."status" IN ('REJECTED', 'CANCELLED') OR NEW."deletedAt" IS NOT NULL THEN
    FOR r IN
      SELECT DISTINCT a."treatmentPlanItemId" AS item
        FROM public."payment_allocations" a
       WHERE a."tenantId" = NEW."tenantId" AND a."treatmentPlanId" = NEW."id"
       ORDER BY 1
    LOOP
      PERFORM public.dx_release_item_allocations(NEW."tenantId", r.item);
    END LOOP;
  END IF;
  INSERT INTO public."plan_allocation_rebalance_requests" ("tenantId", "treatmentPlanId")
  VALUES (NEW."tenantId", NEW."id");
  RETURN NULL;
END;
$$;

CREATE TRIGGER "treatment_plans_allocations"
  AFTER UPDATE OF "status", "deletedAt" ON "treatment_plans"
  FOR EACH ROW EXECUTE FUNCTION public.treatment_plans_allocations();

-- ---------------------------------------------------------------------------
-- RLS FORCE
-- ---------------------------------------------------------------------------
ALTER TABLE "payment_plan_amounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_allocation_rebalance_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_allocation_movements" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "payment_plan_amounts"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON "payment_allocations"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON "plan_allocation_rebalance_requests"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON "payment_allocation_movements"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "payment_plan_amounts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_allocations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "plan_allocation_rebalance_requests" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_allocation_movements" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Grants (la app; los privilegios por defecto le dan además lo que aquí se
-- quita). REVOKE de tabla primero: también quita los de columna.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON "payment_plan_amounts" FROM dentalix_app;
GRANT SELECT, INSERT ON "payment_plan_amounts" TO dentalix_app;
GRANT UPDATE ("manual") ON "payment_plan_amounts" TO dentalix_app;

REVOKE UPDATE, TRUNCATE ON "payment_allocations" FROM dentalix_app;
GRANT SELECT, INSERT, DELETE ON "payment_allocations" TO dentalix_app;
GRANT UPDATE ("amount", "updatedAt") ON "payment_allocations" TO dentalix_app;

REVOKE UPDATE, TRUNCATE ON "plan_allocation_rebalance_requests" FROM dentalix_app;
GRANT SELECT, INSERT, DELETE ON "plan_allocation_rebalance_requests" TO dentalix_app;
GRANT USAGE, SELECT ON SEQUENCE "plan_allocation_rebalance_requests_id_seq" TO dentalix_app;

REVOKE UPDATE, DELETE, TRUNCATE ON "payment_allocation_movements" FROM dentalix_app;
GRANT SELECT, INSERT ON "payment_allocation_movements" TO dentalix_app;
