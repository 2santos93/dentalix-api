-- DX-586: la tasa «al momento». Un abono congela QUÉ tasa usó y CUÁNDO se
-- cotizó; una clínica con tasa manual puede registrar varias el mismo día
-- (cada una desde su hora); y «Actualizar tasa» se puede pedir una vez cada
-- 5 minutos por clínica.
--
-- 1. "payments": tres columnas NULL, sin DEFAULT ni relleno (ADD COLUMN sin
--    reescribir la tabla). NULL en los abonos anteriores y en los que no
--    convierten:
--      "exchangeRateQuotedAt"  instante de la cotización (hora de la BD: lo
--                              pone el trigger de abajo al congelar),
--      "exchangeRateValueDate" fecha valor del BCV (solo con fuente BCV),
--      "exchangeRateRef"       referencia estable a la tasa usada
--                              (BCV:<fecha valor>, AUTOMATIC:<día>,
--                              MANUAL:<id de manual_exchange_rates>, o dos
--                              unidas con «+»).
--    CHECK payments_exchange_rate_moment_check NOT VALID (se valida en
--    20270128140300): van juntas y con la tasa congelada de DX-375, y la
--    fecha valor solo con BCV.
-- 2. Trigger payments_exchange_rate_quoted_at: al congelar (INSERT con
--    "exchangeRateRef", o UPDATE que la pone) fija "exchangeRateQuotedAt" con
--    now() de la BD; después no cambia (y sin referencia, NULL). Una réplica anterior no escribe
--    "exchangeRateRef": sus abonos quedan con las tres NULL, como antes. Abre
--    la puerta de la fusión de pacientes (DX-266), como las demás guardas.
-- 3. "manual_exchange_rates"."effectiveFrom" (TIMESTAMPTZ, NULL aquí; el
--    relleno es 20270128140100 y el NOT NULL y el cambio del índice único,
--    20270128140200). Una réplica anterior que inserte sin ella recibe el
--    inicio del día en la sede principal (trigger
--    manual_exchange_rates_effective_from), el mismo valor del relleno.
-- 4. El trigger de «tasa manual ya usada» (DX-375) mira la referencia: con
--    varias tasas al día, un abono que usó la de las 08:00 no bloquea la de
--    las 14:30. Los abonos sin referencia (anteriores) siguen con la regla de
--    siempre (día y moneda).
-- 5. "tenants"."exchangeRateRefreshedAt" (TIMESTAMPTZ NULL): la última vez
--    que la clínica pidió «Actualizar tasa».
--
-- ADD COLUMN, ADD CONSTRAINT NOT VALID, CREATE TRIGGER y CREATE OR REPLACE
-- FUNCTION toman bloqueos breves sin leer las tablas. lock_timeout 5 s: si
-- una transacción larga los retiene, falla limpia; para reintentar, `npx
-- prisma migrate resolve --rolled-back 20270128140000_dx586_rate_moment` y
-- de nuevo el deploy. RLS FORCE no se toca. DX-266: ninguna columna nueva
-- apunta a "patients": dx_merge_patients no cambia.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payments"
  ADD COLUMN "exchangeRateQuotedAt" TIMESTAMPTZ(3),
  ADD COLUMN "exchangeRateValueDate" DATE,
  ADD COLUMN "exchangeRateRef" TEXT;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_exchange_rate_moment_check" CHECK (
    (
      "exchangeRateRef" IS NULL AND "exchangeRateQuotedAt" IS NULL
      AND "exchangeRateValueDate" IS NULL
    )
    OR (
      "exchangeRateRef" IS NOT NULL AND "exchangeRateQuotedAt" IS NOT NULL
      AND pg_catalog.length("exchangeRateRef") BETWEEN 1 AND 200
      AND "exchangeRateFrom" IS NOT NULL
      AND ("exchangeRateValueDate" IS NULL
           OR "exchangeRateSource" = 'BCV'::"ExchangeRateSource")
    )
  ) NOT VALID;

CREATE FUNCTION public.dx_payment_exchange_rate_quoted_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de la
  -- fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  -- El instante de la BD en UTC (DX-226: nunca la zona de la sesión), como
  -- TIMESTAMPTZ.
  IF NEW."exchangeRateRef" IS NULL THEN
    NEW."exchangeRateQuotedAt" := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD."exchangeRateRef" IS NULL THEN
    NEW."exchangeRateQuotedAt" := pg_catalog.timezone('UTC', pg_catalog.now()) AT TIME ZONE 'UTC';
  ELSE
    NEW."exchangeRateQuotedAt" := OLD."exchangeRateQuotedAt";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_exchange_rate_quoted_at"
  BEFORE INSERT OR UPDATE OF "exchangeRateRef", "exchangeRateQuotedAt" ON "payments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payment_exchange_rate_quoted_at();

ALTER TABLE "manual_exchange_rates"
  ADD COLUMN "effectiveFrom" TIMESTAMPTZ(3);

ALTER TABLE "manual_exchange_rates"
  ADD CONSTRAINT "manual_exchange_rates_effective_from_check"
  CHECK ("effectiveFrom" IS NOT NULL) NOT VALID;

-- El inicio del día civil `day` en la zona de la sede principal de la clínica
-- (la activa más antigua, R6), o UTC si no tiene ninguna con zona. Lee
-- "locations" con la RLS de quien llama (la clínica del contexto).
CREATE FUNCTION public.dx_manual_rate_day_start(tenant uuid, day date)
  RETURNS timestamptz
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (day::timestamp) AT TIME ZONE COALESCE(
    (SELECT l."timeZone" FROM public."locations" l
      WHERE l."tenantId" = tenant AND l."deletedAt" IS NULL
        AND l."isActive" AND l."timeZone" IS NOT NULL
      ORDER BY l."createdAt", l."id"
      LIMIT 1),
    'UTC')
$$;

CREATE FUNCTION public.dx_manual_rate_effective_from() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."effectiveFrom" IS NULL THEN
    NEW."effectiveFrom" := public.dx_manual_rate_day_start(NEW."tenantId", NEW."date");
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "manual_exchange_rates_effective_from"
  BEFORE INSERT ON "manual_exchange_rates"
  FOR EACH ROW EXECUTE FUNCTION public.dx_manual_rate_effective_from();

-- DX-375 + DX-586: una tasa manual la usa un abono que la nombra en su
-- referencia (MANUAL:<id>) o, si es anterior a DX-586 (sin referencia), uno
-- que congeló una tasa MANUAL de ese día con esa moneda. El filtro por día
-- sigue usando payments_exchange_rate_manual_idx.
CREATE OR REPLACE FUNCTION public.dx_manual_exchange_rate_in_use_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."rate" IS DISTINCT FROM OLD."rate" AND EXISTS (
    SELECT 1 FROM public."payments" p
     WHERE p."tenantId" = OLD."tenantId"
       AND p."exchangeRateSource" = 'MANUAL'::public."ExchangeRateSource"
       AND p."exchangeRateDate" = OLD."date"
       AND (
         (p."exchangeRateRef" IS NULL
          AND (p."currency" = OLD."currency"
               OR p."exchangeRateCurrency" = OLD."currency"))
         OR pg_catalog.strpos(p."exchangeRateRef", 'MANUAL:' || OLD."id"::text) > 0
       )
  ) THEN
    RAISE EXCEPTION 'La tasa manual ya la usa un abono y no se puede cambiar (DX-375)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "tenants"
  ADD COLUMN "exchangeRateRefreshedAt" TIMESTAMPTZ(3);
