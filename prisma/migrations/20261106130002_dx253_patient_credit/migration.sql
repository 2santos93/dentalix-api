-- DX-253: saldo a favor del paciente — traspaso a otro plan y devolución.
--
-- Cambios:
--   tenants."creditReceptionMaxAmount"  tope de RECEPTION por movimiento (0 =
--                                       no puede; ADMIN no tiene tope), mismo
--                                       patrón que la política de DX-204.
--   patient_credit_transfers            traspaso (cabecera): origen y destino
--                                       del MISMO paciente (FK compuesta con
--                                       "patientId" a los dos planes).
--   patient_credit_refunds              devolución con su comprobante: serie
--                                       propia por sede y número consecutivo
--                                       (contador), método, motivo, caja de
--                                       efectivo y foto inmutable.
--   patient_credit_refund_payments      abonos de referencia de la devolución,
--                                       del MISMO plan (FK compuesta).
--   patient_credit_entries              asientos con signo en la moneda del
--                                       plan: un traspaso = TRANSFER_OUT (−) en
--                                       el origen + TRANSFER_IN (+) en el
--                                       destino; una devolución = REFUND (−).
--                                       El saldo los suma a lo abonado.
--   patient_credit_refund_counters      contador por clínica y serie (UPSERT
--                                       en la transacción: sin huecos ni
--                                       duplicados, como payment_receipt_counters).
--
-- Reglas en la BD:
--   * FK COMPUESTAS por tenant (SEC-004) en todas las tablas nuevas: sede,
--     plan(es) y paciente, caja y abonos de la MISMA clínica.
--   * Append-only: traspasos, devoluciones, abonos de referencia y asientos no
--     admiten UPDATE ni DELETE (trigger + REVOKE); solo un superusuario borra
--     (limpieza de tests), como payment_allocation_movements (DX-051).
--   * Una devolución con caja es en EFECTIVO, en una caja ABIERTA de su sede
--     (trigger de alta); "createdAt" lo pone la BD en UTC (DX-226).
--   * RLS FORCE con NULLIF en las cinco tablas.
--   * Cartera: `patient_ledgers_compute` suma los asientos al abonado del plan
--     y un trigger de patient_credit_entries refresca el resumen del paciente.
--
-- Compatible hacia atrás: AÑADE una columna con DEFAULT (sin reescritura en
-- PG ≥ 11), un enum y tablas vacías. El código anterior no las conoce: un
-- plan sin asientos tiene el mismo saldo que antes.

SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "PatientCreditEntryKind" AS ENUM ('TRANSFER_OUT', 'TRANSFER_IN', 'REFUND');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "creditReceptionMaxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "patient_credit_transfers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "sourcePlanId" UUID NOT NULL,
    "targetPlanId" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,
    "idempotencyFingerprint" TEXT,

    CONSTRAINT "patient_credit_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_credit_refunds" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "treatmentPlanId" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reason" TEXT NOT NULL,
    "cashSessionId" UUID,
    "seriesPrefix" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,
    "idempotencyFingerprint" TEXT,

    CONSTRAINT "patient_credit_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_credit_refund_payments" (
    "tenantId" UUID NOT NULL,
    "refundId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "treatmentPlanId" UUID NOT NULL,

    CONSTRAINT "patient_credit_refund_payments_pkey" PRIMARY KEY ("refundId","paymentId")
);

-- CreateTable
CREATE TABLE "patient_credit_entries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "treatmentPlanId" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "kind" "PatientCreditEntryKind" NOT NULL,
    "transferId" UUID,
    "refundId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_credit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_credit_refund_counters" (
    "tenantId" UUID NOT NULL,
    "seriesPrefix" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL,

    CONSTRAINT "patient_credit_refund_counters_pkey" PRIMARY KEY ("tenantId","seriesPrefix")
);

-- CreateIndex
CREATE INDEX "patient_credit_transfers_tenant_patient_idx" ON "patient_credit_transfers"("tenantId", "patientId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "patient_credit_transfers_tenant_source_idx" ON "patient_credit_transfers"("tenantId", "sourcePlanId");

-- CreateIndex
CREATE INDEX "patient_credit_transfers_tenant_target_idx" ON "patient_credit_transfers"("tenantId", "targetPlanId");

-- CreateIndex
CREATE INDEX "patient_credit_transfers_tenant_location_idx" ON "patient_credit_transfers"("tenantId", "locationId");

-- CreateIndex
CREATE INDEX "patient_credit_transfers_currency_idx" ON "patient_credit_transfers"("currency");

-- CreateIndex
CREATE UNIQUE INDEX "patient_credit_transfers_tenant_id_key" ON "patient_credit_transfers"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_credit_transfers_tenant_idempotency_key" ON "patient_credit_transfers"("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;

-- CreateIndex
CREATE INDEX "patient_credit_refunds_tenant_patient_idx" ON "patient_credit_refunds"("tenantId", "patientId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "patient_credit_refunds_tenant_plan_idx" ON "patient_credit_refunds"("tenantId", "treatmentPlanId", "patientId");

-- CreateIndex
CREATE INDEX "patient_credit_refunds_tenant_cash_session_idx" ON "patient_credit_refunds"("tenantId", "cashSessionId");

-- CreateIndex
CREATE INDEX "patient_credit_refunds_tenant_location_idx" ON "patient_credit_refunds"("tenantId", "locationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "patient_credit_refunds_currency_idx" ON "patient_credit_refunds"("currency");

-- CreateIndex
CREATE UNIQUE INDEX "patient_credit_refunds_tenant_id_key" ON "patient_credit_refunds"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_credit_refunds_tenant_id_plan_key" ON "patient_credit_refunds"("tenantId", "id", "treatmentPlanId");

-- CreateIndex
CREATE UNIQUE INDEX "patient_credit_refunds_tenant_series_number_key" ON "patient_credit_refunds"("tenantId", "seriesPrefix", "number");

-- CreateIndex
CREATE UNIQUE INDEX "patient_credit_refunds_tenant_idempotency_key" ON "patient_credit_refunds"("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;

-- CreateIndex
CREATE INDEX "patient_credit_refund_payments_refund_idx" ON "patient_credit_refund_payments"("tenantId", "refundId", "treatmentPlanId");

-- CreateIndex
CREATE INDEX "patient_credit_refund_payments_payment_idx" ON "patient_credit_refund_payments"("tenantId", "paymentId", "treatmentPlanId");

-- CreateIndex
CREATE INDEX "patient_credit_entries_tenant_plan_idx" ON "patient_credit_entries"("tenantId", "treatmentPlanId", "patientId");

-- CreateIndex
CREATE INDEX "patient_credit_entries_tenant_patient_idx" ON "patient_credit_entries"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "patient_credit_entries_tenant_transfer_idx" ON "patient_credit_entries"("tenantId", "transferId");

-- CreateIndex
CREATE INDEX "patient_credit_entries_tenant_refund_idx" ON "patient_credit_entries"("tenantId", "refundId");

-- CreateIndex
CREATE INDEX "patient_credit_entries_currency_idx" ON "patient_credit_entries"("currency");

-- AddForeignKey
ALTER TABLE "patient_credit_transfers" ADD CONSTRAINT "patient_credit_transfers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_credit_transfers" ADD CONSTRAINT "patient_credit_transfers_location_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_credit_transfers" ADD CONSTRAINT "patient_credit_transfers_source_plan_fkey" FOREIGN KEY ("tenantId", "sourcePlanId", "patientId") REFERENCES "treatment_plans"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "patient_credit_transfers" ADD CONSTRAINT "patient_credit_transfers_target_plan_fkey" FOREIGN KEY ("tenantId", "targetPlanId", "patientId") REFERENCES "treatment_plans"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "patient_credit_transfers" ADD CONSTRAINT "patient_credit_transfers_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_credit_refunds" ADD CONSTRAINT "patient_credit_refunds_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_credit_refunds" ADD CONSTRAINT "patient_credit_refunds_location_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_credit_refunds" ADD CONSTRAINT "patient_credit_refunds_plan_fkey" FOREIGN KEY ("tenantId", "treatmentPlanId", "patientId") REFERENCES "treatment_plans"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "patient_credit_refunds" ADD CONSTRAINT "patient_credit_refunds_cash_session_fkey" FOREIGN KEY ("tenantId", "cashSessionId") REFERENCES "cash_sessions"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "patient_credit_refunds" ADD CONSTRAINT "patient_credit_refunds_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_credit_refund_payments" ADD CONSTRAINT "patient_credit_refund_payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_credit_refund_payments" ADD CONSTRAINT "patient_credit_refund_payments_refund_fkey" FOREIGN KEY ("tenantId", "refundId", "treatmentPlanId") REFERENCES "patient_credit_refunds"("tenantId", "id", "treatmentPlanId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "patient_credit_refund_payments" ADD CONSTRAINT "patient_credit_refund_payments_payment_fkey" FOREIGN KEY ("tenantId", "paymentId", "treatmentPlanId") REFERENCES "payments"("tenantId", "id", "treatmentPlanId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "patient_credit_entries" ADD CONSTRAINT "patient_credit_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_credit_entries" ADD CONSTRAINT "patient_credit_entries_plan_fkey" FOREIGN KEY ("tenantId", "treatmentPlanId", "patientId") REFERENCES "treatment_plans"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "patient_credit_entries" ADD CONSTRAINT "patient_credit_entries_transfer_fkey" FOREIGN KEY ("tenantId", "transferId") REFERENCES "patient_credit_transfers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "patient_credit_entries" ADD CONSTRAINT "patient_credit_entries_refund_fkey" FOREIGN KEY ("tenantId", "refundId") REFERENCES "patient_credit_refunds"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "patient_credit_entries" ADD CONSTRAINT "patient_credit_entries_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_credit_refund_counters" ADD CONSTRAINT "patient_credit_refund_counters_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CHECKs
-- ---------------------------------------------------------------------------
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_credit_reception_max_check"
  CHECK ("creditReceptionMaxAmount" >= 0);

ALTER TABLE "patient_credit_transfers"
  ADD CONSTRAINT "patient_credit_transfers_amount_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "patient_credit_transfers_plans_check" CHECK ("sourcePlanId" <> "targetPlanId"),
  ADD CONSTRAINT "patient_credit_transfers_reason_check"
    CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 3 AND 500);

ALTER TABLE "patient_credit_refunds"
  ADD CONSTRAINT "patient_credit_refunds_amount_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "patient_credit_refunds_reason_check"
    CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500),
  ADD CONSTRAINT "patient_credit_refunds_number_check" CHECK ("number" > 0),
  -- Solo el efectivo sale de una caja.
  ADD CONSTRAINT "patient_credit_refunds_cash_check"
    CHECK ("cashSessionId" IS NULL OR "method" = 'CASH');

ALTER TABLE "patient_credit_entries"
  ADD CONSTRAINT "patient_credit_entries_source_check" CHECK (
    ("kind" IN ('TRANSFER_OUT', 'TRANSFER_IN') AND "transferId" IS NOT NULL AND "refundId" IS NULL)
    OR ("kind" = 'REFUND' AND "refundId" IS NOT NULL AND "transferId" IS NULL)
  ),
  ADD CONSTRAINT "patient_credit_entries_sign_check" CHECK (
    ("kind" = 'TRANSFER_IN' AND "amount" > 0)
    OR ("kind" IN ('TRANSFER_OUT', 'REFUND') AND "amount" < 0)
  );

ALTER TABLE "patient_credit_refund_counters"
  ADD CONSTRAINT "patient_credit_refund_counters_last_check" CHECK ("lastNumber" > 0);

-- ---------------------------------------------------------------------------
-- Hora del servidor (DX-226) y alta de una devolución con caja.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx253_server_created_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patient_credit_transfers_server_created_at"
  BEFORE INSERT ON "patient_credit_transfers"
  FOR EACH ROW EXECUTE FUNCTION public.dx253_server_created_at();
CREATE TRIGGER "patient_credit_refunds_server_created_at"
  BEFORE INSERT ON "patient_credit_refunds"
  FOR EACH ROW EXECUTE FUNCTION public.dx253_server_created_at();
CREATE TRIGGER "patient_credit_entries_server_created_at"
  BEFORE INSERT ON "patient_credit_entries"
  FOR EACH ROW EXECUTE FUNCTION public.dx253_server_created_at();

-- La caja de una devolución está ABIERTA y es de su sede (como un abono,
-- DX-027): nunca entra en una caja cerrada.
CREATE FUNCTION public.patient_credit_refunds_cash_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."cashSessionId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."cash_sessions" s
     WHERE s."tenantId" = NEW."tenantId"
       AND s."id" = NEW."cashSessionId"
       AND s."locationId" = NEW."locationId"
       AND s."status" = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'La caja de la devolución no está abierta en su sede (DX-253)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patient_credit_refunds_cash_guard"
  BEFORE INSERT ON "patient_credit_refunds"
  FOR EACH ROW EXECUTE FUNCTION public.patient_credit_refunds_cash_guard();

-- ---------------------------------------------------------------------------
-- Append-only: sin UPDATE; DELETE/TRUNCATE solo de un superusuario.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.patient_credit_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND public.dx_cash_is_superuser() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es un registro contable: no admite % (DX-253)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "patient_credit_transfers_append_only"
  BEFORE UPDATE OR DELETE ON "patient_credit_transfers"
  FOR EACH ROW EXECUTE FUNCTION public.patient_credit_append_only();
CREATE TRIGGER "patient_credit_transfers_no_truncate"
  BEFORE TRUNCATE ON "patient_credit_transfers"
  FOR EACH STATEMENT EXECUTE FUNCTION public.patient_credit_append_only();
CREATE TRIGGER "patient_credit_refunds_append_only"
  BEFORE UPDATE OR DELETE ON "patient_credit_refunds"
  FOR EACH ROW EXECUTE FUNCTION public.patient_credit_append_only();
CREATE TRIGGER "patient_credit_refunds_no_truncate"
  BEFORE TRUNCATE ON "patient_credit_refunds"
  FOR EACH STATEMENT EXECUTE FUNCTION public.patient_credit_append_only();
CREATE TRIGGER "patient_credit_refund_payments_append_only"
  BEFORE UPDATE OR DELETE ON "patient_credit_refund_payments"
  FOR EACH ROW EXECUTE FUNCTION public.patient_credit_append_only();
CREATE TRIGGER "patient_credit_refund_payments_no_truncate"
  BEFORE TRUNCATE ON "patient_credit_refund_payments"
  FOR EACH STATEMENT EXECUTE FUNCTION public.patient_credit_append_only();
CREATE TRIGGER "patient_credit_entries_append_only"
  BEFORE UPDATE OR DELETE ON "patient_credit_entries"
  FOR EACH ROW EXECUTE FUNCTION public.patient_credit_append_only();
CREATE TRIGGER "patient_credit_entries_no_truncate"
  BEFORE TRUNCATE ON "patient_credit_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION public.patient_credit_append_only();

-- ---------------------------------------------------------------------------
-- RLS FORCE
-- ---------------------------------------------------------------------------
ALTER TABLE "patient_credit_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_credit_refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_credit_refund_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_credit_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_credit_refund_counters" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "patient_credit_transfers"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON "patient_credit_refunds"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON "patient_credit_refund_payments"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON "patient_credit_entries"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON "patient_credit_refund_counters"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "patient_credit_transfers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_credit_refunds" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_credit_refund_payments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_credit_entries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_credit_refund_counters" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Grants: los privilegios por defecto dan a dentalix_app SELECT, INSERT,
-- UPDATE y DELETE; aquí se recortan (REVOKE de tabla primero).
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON "patient_credit_transfers" FROM dentalix_app;
GRANT SELECT, INSERT ON "patient_credit_transfers" TO dentalix_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "patient_credit_refunds" FROM dentalix_app;
GRANT SELECT, INSERT ON "patient_credit_refunds" TO dentalix_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "patient_credit_refund_payments" FROM dentalix_app;
GRANT SELECT, INSERT ON "patient_credit_refund_payments" TO dentalix_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "patient_credit_entries" FROM dentalix_app;
GRANT SELECT, INSERT ON "patient_credit_entries" TO dentalix_app;
-- El contador avanza con UPSERT: UPDATE solo de "lastNumber".
REVOKE UPDATE, DELETE, TRUNCATE ON "patient_credit_refund_counters" FROM dentalix_app;
GRANT SELECT, INSERT ON "patient_credit_refund_counters" TO dentalix_app;
GRANT UPDATE ("lastNumber") ON "patient_credit_refund_counters" TO dentalix_app;


-- ---------------------------------------------------------------------------
-- Cartera (DX-155): el resumen `patient_ledgers` suma los asientos al abonado
-- del plan en su moneda. Mismo cuerpo que en
-- 20261023140000_dx262_payments_opening_balance, con el LATERAL "cred".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."patient_ledgers_compute"()
  RETURNS TABLE (
    "tenantId"   uuid,
    "patientId"  uuid,
    "locationId" uuid,
    "owing"      boolean,
    "ledger"     jsonb
  )
  LANGUAGE sql
  STABLE
AS $$
  SELECT pa."tenantId", pa."id",
         COALESCE(visit."locationId", paid."locationId", presented."locationId", ob."locationId"),
         pa."deletedAt" IS NULL AND (COALESCE(pl."owing", false) OR COALESCE(ob."owing", false)),
         pg_catalog.jsonb_build_object(
           'plans', COALESCE(pl."plans", '[]'::jsonb),
           'paymentPlans', COALESCE(sched."paymentPlans", '[]'::jsonb),
           'openings', COALESCE(ob."openings", '[]'::jsonb))
    FROM public."patients" pa
    -- Sede de la deuda: última cita atendida (índice parcial de DX-145) …
    LEFT JOIN LATERAL (
      SELECT a."locationId"
        FROM public."appointments" a
       WHERE a."tenantId" = pa."tenantId"
         AND a."patientId" = pa."id"
         AND a."status" = 'COMPLETED'
         AND a."deletedAt" IS NULL
       ORDER BY a."start" DESC, a."id" DESC
       LIMIT 1
    ) visit ON true
    -- … o último abono vivo …
    LEFT JOIN LATERAL (
      SELECT p."locationId"
        FROM public."payments" p
       WHERE p."tenantId" = pa."tenantId"
         AND p."patientId" = pa."id"
         AND p."deletedAt" IS NULL
       ORDER BY p."paidAt" DESC, p."id" DESC
       LIMIT 1
    ) paid ON true
    -- … o última presentación de un plan vivo …
    LEFT JOIN LATERAL (
      SELECT tp."presentedLocationId" AS "locationId"
        FROM public."treatment_plans" tp
       WHERE tp."tenantId" = pa."tenantId"
         AND tp."patientId" = pa."id"
         AND tp."deletedAt" IS NULL
         AND tp."presentedLocationId" IS NOT NULL
       ORDER BY tp."presentedAt" DESC NULLS LAST, tp."id" DESC
       LIMIT 1
    ) presented ON true
    -- … o la del último saldo migrado vivo (DX-262), con lo abonado a él.
    LEFT JOIN LATERAL (
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
               o."id", o."currency", o."amount",
               pg_catalog.to_char(o."asOfDate", 'YYYY-MM-DD'), o."asOfDateApproximate",
               COALESCE(op."paid", 0))
               ORDER BY o."asOfDate", o."id") AS "openings",
             pg_catalog.bool_or(o."amount" > COALESCE(op."paid", 0)) AS "owing",
             (pg_catalog.array_agg(o."locationId" ORDER BY o."createdAt" DESC, o."id" DESC))[1]
               AS "locationId"
        FROM public."opening_balances" o
        -- Abonos vivos contra el saldo, en su moneda (la API no admite otra).
        LEFT JOIN LATERAL (
          SELECT pg_catalog.sum(p."amount") AS "paid"
            FROM public."payments" p
           WHERE p."tenantId" = o."tenantId"
             AND p."openingBalanceId" = o."id"
             AND p."currency" = o."currency"
             AND p."deletedAt" IS NULL
        ) op ON true
       WHERE o."tenantId" = pa."tenantId"
         AND o."patientId" = pa."id"
         AND o."voidedAt" IS NULL
    ) ob ON true
    -- Planes vivos con sus sumas.
    LEFT JOIN LATERAL (
      SELECT pg_catalog.bool_or(s."billable" > s."paidOwn") AS "owing",
             pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
               s."id", s."status", s."currency", s."createdMs", s."agingFromMs",
               s."billable", NULLIF(s."paidOwn", 0), s."paidOther")
               ORDER BY s."id") AS "plans"
        FROM (
          SELECT tp."id", tp."status", tp."currency",
                 (EXTRACT(EPOCH FROM tp."createdAt") * 1000)::float8 AS "createdMs",
                 (EXTRACT(EPOCH FROM COALESCE(acc."acceptedAt", tp."presentedAt", tp."createdAt")) * 1000)::float8
                   AS "agingFromMs",
                 COALESCE(items."billable", 0) AS "billable",
                 COALESCE(pays."own", 0) + COALESCE(cred."net", 0) AS "paidOwn",
                 pays."other" AS "paidOther"
            FROM public."treatment_plans" tp
            LEFT JOIN public."treatment_plan_acceptances" acc
              ON acc."tenantId" = tp."tenantId" AND acc."planId" = tp."id"
            LEFT JOIN LATERAL (
              SELECT pg_catalog.sum(i."price") - pg_catalog.sum(i."discount") AS "billable"
                FROM public."treatment_plan_items" i
               WHERE i."tenantId" = tp."tenantId"
                 AND i."planId" = tp."id"
                 AND i."deletedAt" IS NULL
                 AND i."status" IN ('ACCEPTED', 'DONE')
            ) items ON true
            LEFT JOIN LATERAL (
              SELECT pg_catalog.sum(c."amount") FILTER (WHERE c."currency" = tp."currency") AS "own",
                     pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c."currency", c."amount")
                       ORDER BY c."currency") FILTER (WHERE c."currency" <> tp."currency") AS "other"
                FROM (SELECT p."currency", pg_catalog.sum(p."amount") AS "amount"
                        FROM public."payments" p
                       WHERE p."tenantId" = tp."tenantId"
                         AND p."treatmentPlanId" = tp."id"
                         AND p."deletedAt" IS NULL
                       GROUP BY p."currency") c
            ) pays ON true
            -- DX-253: asientos del saldo a favor (traspasos y devoluciones), en
            -- la moneda del plan, con signo: cuentan como lo abonado.
            LEFT JOIN LATERAL (
              SELECT pg_catalog.sum(e."amount") AS "net"
                FROM public."patient_credit_entries" e
               WHERE e."tenantId" = tp."tenantId"
                 AND e."treatmentPlanId" = tp."id"
                 AND e."currency" = tp."currency"
            ) cred ON true
           WHERE tp."tenantId" = pa."tenantId"
             AND tp."patientId" = pa."id"
             AND tp."deletedAt" IS NULL
        ) s
    ) pl ON true
    -- Planes de cuotas vivos, no cancelados, de planes vivos, con sus cuotas.
    LEFT JOIN LATERAL (
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
               pp."id", pp."treatmentPlanId", pp."currency", pp."status",
               pp."downPayment",
               (EXTRACT(EPOCH FROM pp."startDate") * 1000)::float8,
               COALESCE((
                 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                          i."sequence",
                          (EXTRACT(EPOCH FROM i."dueDate") * 1000)::float8,
                          i."amount") ORDER BY i."sequence")
                   FROM public."installments" i
                  WHERE i."tenantId" = pp."tenantId"
                    AND i."paymentPlanId" = pp."id"
               ), '[]'::jsonb))
               ORDER BY pp."id") AS "paymentPlans"
        FROM public."payment_plans" pp
        JOIN public."treatment_plans" tp
          ON tp."tenantId" = pp."tenantId" AND tp."id" = pp."treatmentPlanId"
       WHERE pp."tenantId" = pa."tenantId"
         AND pp."patientId" = pa."id"
         AND pp."deletedAt" IS NULL
         AND pp."status" <> 'CANCELLED'
         AND tp."deletedAt" IS NULL
    ) sched ON true
$$;

CREATE FUNCTION public."patient_ledgers_on_credit_entries"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ts uuid[];
  ps uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT pg_catalog.array_agg(n."tenantId"), pg_catalog.array_agg(n."patientId")
      INTO ts, ps FROM new_rows n;
  ELSE
    SELECT pg_catalog.array_agg(o."tenantId"), pg_catalog.array_agg(o."patientId")
      INTO ts, ps FROM old_rows o;
  END IF;
  PERFORM public."patient_ledgers_refresh"(ts, ps);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "patient_ledgers_credit_entries_insert"
  AFTER INSERT ON "patient_credit_entries"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public."patient_ledgers_on_credit_entries"();
CREATE TRIGGER "patient_ledgers_credit_entries_delete"
  AFTER DELETE ON "patient_credit_entries"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public."patient_ledgers_on_credit_entries"();
