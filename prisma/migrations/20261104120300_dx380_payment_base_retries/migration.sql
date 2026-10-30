-- DX-380 (OPS-045, DB-056): estado de reintento de los abonos que se quedaron
-- sin base de imputación (DX-051) o sin su tasa congelada (DX-375), y la
-- lista de trabajo del barrido de cada minuto.
--
-- Cambios:
--   "PaymentBaseRetryReason"   NO_RATE (sin tasa: manual sin registrar,
--                              proveedor caído, tiempo agotado o presupuesto)
--                              o ERROR (otro fallo).
--   payment_base_retries       una fila por abono pendiente: intentos,
--                              próximo intento, último motivo y desde cuándo.
--                              El barrido elige `"nextAttemptAt" <= now()
--                              ORDER BY "nextAttemptAt"` (índice
--                              payment_base_retries_due_idx) y la borra cuando
--                              el abono tiene su tasa y su base; si no, la
--                              aplaza 1 min → 5 → 30 → 2 h → 24 h (la API).
--   dx_payment_base_retry_enroll()  trigger DIFERIDO de `payments` (al
--                              confirmar el alta): si el abono queda vivo y
--                              «sin tasa» (o anterior sin congelar) o, si es a
--                              un plan vivo, sin base, crea su fila. Así entra
--                              también lo que registre una réplica anterior
--                              durante el despliegue escalonado.
--   dx_payment_allocation_sweep_tenants()  las clínicas vivas con un
--                              reintento vencido o un plan por repartir, en
--                              una sola sentencia: el barrido solo abre
--                              transacción en esas (antes, en todas, con un
--                              Seq Scan de payments por clínica: DB-056).
--
-- Reglas en la BD:
--   * PK ("tenantId", "paymentId") y FK COMPUESTA por clínica al abono
--     (payments_tenant_id_key, migración anterior), ON DELETE CASCADE: la fila
--     es un dato operativo del abono, no historia. ON UPDATE RESTRICT.
--   * attempts >= 0 y "lastReason" presente si y solo si attempts > 0.
--   * Fechas en UTC puestas por la BD (DX-226); la app escribe
--     "nextAttemptAt" a partir de la hora de la BD.
--   * RLS FORCE por tenant con la política NULLIF de siempre. La app tiene
--     SELECT, INSERT, UPDATE y DELETE (borra la fila al resolver); sin
--     TRUNCATE.
--   * Las dos funciones son SECURITY INVOKER (corren con los permisos y la
--     RLS de quien llama) y fijan search_path = pg_catalog, pg_temp con los
--     nombres calificados (SEC-032). La del barrido recorre las clínicas
--     fijando `app.current_tenant` en cada una (como el relleno de DX-375),
--     así que solo ve las filas de esa clínica; al terminar deja el valor que
--     había. Devuelve solo ids de clínica.
--
-- Compatible hacia atrás: tabla nueva, tipo nuevo y un trigger que solo
-- inserta en la tabla nueva. Una réplica anterior no la nombra: sigue con su
-- barrido de siempre (todas las clínicas, 50 abonos por la más reciente) y sus
-- abonos sin tasa entran igual en la lista por el trigger.
--
-- Bloqueos: CREATE TRIGGER toma SHARE ROW EXCLUSIVE en `payments` (frena las
-- altas de abonos un instante, no las lecturas); la FK, SHARE ROW EXCLUSIVE en
-- `payments` hasta el COMMIT. Tabla nueva y vacía: la FK no valida filas, así
-- que no hace falta el bracket NO FORCE/FORCE de DX-134. lock_timeout 5 s: si
-- una transacción larga retiene `payments`, falla limpia; se ejecuta `npx
-- prisma migrate resolve --rolled-back 20261104120300_dx380_payment_base_retries`
-- y se repite `migrate deploy`.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "PaymentBaseRetryReason" AS ENUM ('NO_RATE', 'ERROR');

CREATE TABLE "payment_base_retries" (
    "tenantId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', now()),
    "lastReason" "PaymentBaseRetryReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', now()),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', now()),

    CONSTRAINT "payment_base_retries_pkey" PRIMARY KEY ("tenantId", "paymentId"),
    CONSTRAINT "payment_base_retries_payment_fkey"
      FOREIGN KEY ("tenantId", "paymentId") REFERENCES "payments"("tenantId", "id")
      ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT "payment_base_retries_attempts_check"
      CHECK ("attempts" >= 0 AND ("attempts" = 0) = ("lastReason" IS NULL))
);

-- La selección del barrido: los vencidos de la clínica, el más antiguo primero.
CREATE INDEX "payment_base_retries_due_idx"
  ON "payment_base_retries"("tenantId", "nextAttemptAt");

GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_base_retries" TO dentalix_app;
REVOKE TRUNCATE ON "payment_base_retries" FROM dentalix_app;

ALTER TABLE "payment_base_retries" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "payment_base_retries"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "payment_base_retries" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Alta en la lista: al confirmar la transacción que creó el abono (la base,
-- si la hay, ya existe y la tasa ya está congelada o no).
-- ---------------------------------------------------------------------------
CREATE FUNCTION dx_payment_base_retry_enroll()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public."payments" p
      LEFT JOIN public."treatment_plans" t
        ON t."tenantId" = p."tenantId"
       AND t."id" = p."treatmentPlanId"
       AND t."deletedAt" IS NULL
     WHERE p."tenantId" = NEW."tenantId"
       AND p."id" = NEW."id"
       AND p."deletedAt" IS NULL
       AND (
             -- «Sin tasa», o anterior a DX-375 sin congelar (el predicado del
             -- índice payments_exchange_rate_pending_idx).
             (p."exchangeRateFrom" IS NULL
              AND (p."exchangeRateCurrency" IS NULL
                   OR p."currency" <> p."exchangeRateCurrency"))
             -- A un plan vivo y sin base.
          OR (t."id" IS NOT NULL
              AND NOT EXISTS (
                    SELECT 1 FROM public."payment_plan_amounts" b
                     WHERE b."tenantId" = p."tenantId"
                       AND b."paymentId" = p."id"))
           )
  ) THEN
    INSERT INTO public."payment_base_retries" ("tenantId", "paymentId")
    VALUES (NEW."tenantId", NEW."id")
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payments_base_retry_enroll"
  AFTER INSERT ON "payments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION dx_payment_base_retry_enroll();

-- ---------------------------------------------------------------------------
-- Clínicas con algo que barrer, sin abrir una transacción por clínica.
-- ---------------------------------------------------------------------------
CREATE FUNCTION dx_payment_allocation_sweep_tenants()
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  VOLATILE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  t uuid;
  previous text := pg_catalog.current_setting('app.current_tenant', true);
BEGIN
  FOR t IN SELECT c."id" FROM public."tenants" c
            WHERE c."deletedAt" IS NULL
            ORDER BY c."id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    IF EXISTS (SELECT 1 FROM public."payment_base_retries" r
                WHERE r."tenantId" = t
                  AND r."nextAttemptAt" <= pg_catalog.timezone('UTC', pg_catalog.now()))
       OR EXISTS (SELECT 1 FROM public."plan_allocation_rebalance_requests" q
                   WHERE q."tenantId" = t) THEN
      RETURN NEXT t;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('app.current_tenant', COALESCE(previous, ''), true);
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION dx_payment_allocation_sweep_tenants() FROM PUBLIC;
REVOKE ALL ON FUNCTION dx_payment_base_retry_enroll() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    GRANT EXECUTE ON FUNCTION dx_payment_allocation_sweep_tenants() TO dentalix_app;
  END IF;
END
$$;
