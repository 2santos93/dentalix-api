-- DX-379 (porción B): «Actualizar precios» (recotizar) un plan abierto con el
-- precio vigente de cada ítem propuesto, con la tasa de hoy y la validez del
-- presupuesto reiniciada.
--
--   treatment_plan_repricings   una fila por recotización: quién, cuándo, en
--                               qué sede, si renovó la validez, la clave de idempotencia (cabecera
--                               Idempotency-Key de /reprice/apply), la tasa
--                               usada, la validez anterior y la nueva, cada
--                               línea antes y después (JSON) y los totales.
--                               Append-only. La auditoría (UPDATE
--                               TREATMENT_PLAN, reason PLAN_REPRICED) la
--                               enlaza por `params.repricingId`: los importes
--                               no van en `audit_events` (DX-009).
--
-- NO ES SOLO ADITIVA. Reemplaza dos funciones de trigger de escritura única:
--   - treatment_plan_items_catalog_currency_frozen (DX-502)
--   - treatment_plan_items_reference_frozen        (DX-513-bis)
-- Recotizar tiene que reescribir la foto del precio del ítem (moneda del
-- catálogo y referencia en la moneda del plan, con la tasa de hoy): si no, el
-- presupuesto mostraría el «Precio de lista» viejo junto al precio nuevo y el
-- informe de descuentos mediría contra la foto vieja. La excepción es
-- estrecha: solo cuando la transacción fija `app.plan_item_reprice = 'on'`
-- (SET LOCAL / set_config(…, true), la pone y la quita el repositorio de la
-- recotización alrededor de sus UPDATE) Y el ítem sigue PROPUESTO Y su plan
-- está abierto (DRAFT o PRESENTED, vivo y sin aceptación firmada). Fuera de
-- la marca, o en un plan aceptado o cerrado, siguen fallando igual que antes
-- (restrict_violation, mismos mensajes). La foto anterior no se pierde: queda
-- en `treatment_plan_repricings.lines`.
--
-- Tabla nueva y vacía: sin relleno. Las FK compuestas por clínica (SEC-004)
-- van dentro del CREATE TABLE (la hija se crea aquí, vacía: nada que validar
-- con FORCE, DX-134). RLS FORCE por clínica, como el resto; la app solo
-- inserta y lee (grants de las tablas de evidencia, como
-- appointment_status_reversals) y un trigger rechaza UPDATE siempre y DELETE
-- con clínica en contexto (la purga del owner sí borra), como
-- treatment_plan_acceptances.
--
-- Vuelta atrás (solo si hay que retirar la recotización):
--   1. Primero se despliega la versión anterior de la API (no escribe ni lee
--      esta tabla ni fija la marca).
--   2. Después, en una transacción con el mismo lock_timeout, se restauran
--      las dos funciones tal como las dejaron
--      20261128090000_dx502_plan_item_catalog_currency y
--      20261201090000_dx513b_plan_item_reference_snapshot (CREATE OR REPLACE
--      con su cuerpo de entonces, sin la llamada a
--      treatment_plan_item_reprice_allowed), y
--        DROP FUNCTION public."treatment_plan_item_reprice_allowed"(uuid, uuid, text, timestamp);
--        DROP TABLE public."treatment_plan_repricings";
--        DROP FUNCTION public."treatment_plan_repricings_append_only"();
--        DROP TYPE public."TreatmentPlanRepricingSource";
--      y se borra de `_prisma_migrations` la fila de esta migración.
--   Se PIERDE el historial de recotizaciones (antes/después, autor, tasa).
--   Los ítems ya recotizados se quedan con su precio y su foto nuevos (son
--   válidos para las funciones restauradas: solo impiden CAMBIARLOS otra
--   vez), y su auditoría queda con un `repricingId` que ya no resuelve.
--
-- lock_timeout 5 s: CREATE OR REPLACE FUNCTION no bloquea la tabla y el
-- CREATE TABLE es de una tabla nueva; las FK toman SHARE ROW EXCLUSIVE un
-- instante en treatment_plans, locations y users.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "TreatmentPlanRepricingSource" AS ENUM ('MANUAL', 'ACCEPT');

CREATE TABLE "treatment_plan_repricings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "source" "TreatmentPlanRepricingSource" NOT NULL,
    "idempotencyKey" UUID,
    "requestFingerprint" CHAR(64),
    "previewHash" CHAR(64) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "rateCurrency" CHAR(3),
    "rateFromPerBase" DECIMAL(18,8),
    "rateToPerBase" DECIMAL(18,8),
    "rateSource" "ExchangeRateSource",
    "rateDate" DATE,
    "previousQuoteIssuedOn" DATE,
    "previousQuoteValidUntil" DATE,
    -- La validez solo se renueva si se recotizaron TODOS los ítems propuestos
    -- vivos del plan; si no, se conserva la anterior (que puede ser NULL).
    "validityRenewed" BOOLEAN NOT NULL,
    "quoteIssuedOn" DATE,
    "quoteValidUntil" DATE,
    "lines" JSONB NOT NULL,
    "skipped" JSONB NOT NULL,
    "totalBefore" DECIMAL(14,2) NOT NULL,
    "totalAfter" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', now()),

    CONSTRAINT "treatment_plan_repricings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "treatment_plan_repricings_plan_fkey"
      FOREIGN KEY ("tenantId", "planId", "patientId")
      REFERENCES "treatment_plans"("tenantId", "id", "patientId")
      ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "treatment_plan_repricings_location_fkey"
      FOREIGN KEY ("tenantId", "locationId")
      REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "treatment_plan_repricings_actor_fkey"
      FOREIGN KEY ("actorUserId") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- La clave y su huella van juntas; aplicar a mano (MANUAL) siempre la
    -- lleva. La porción C (ACCEPT) recotiza dentro de la firma, sin clave.
    CONSTRAINT "treatment_plan_repricings_idempotency_check" CHECK (
      ("idempotencyKey" IS NULL) = ("requestFingerprint" IS NULL)
      AND ("source" <> 'MANUAL' OR "idempotencyKey" IS NOT NULL)
    ),
    CONSTRAINT "treatment_plan_repricings_hash_check" CHECK (
      "previewHash" ~ '^[0-9a-f]{64}$'
      AND ("requestFingerprint" IS NULL OR "requestFingerprint" ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT "treatment_plan_repricings_currency_check" CHECK (
      "currency" ~ '^[A-Z]{3}$'
      AND ("rateCurrency" IS NULL OR "rateCurrency" ~ '^[A-Z]{3}$')
    ),
    CONSTRAINT "treatment_plan_repricings_rate_check" CHECK (
      (
        "rateCurrency" IS NULL AND "rateFromPerBase" IS NULL
        AND "rateToPerBase" IS NULL AND "rateSource" IS NULL
        AND "rateDate" IS NULL
      )
      OR (
        "rateCurrency" IS NOT NULL AND "rateFromPerBase" > 0
        AND "rateToPerBase" > 0 AND "rateSource" IS NOT NULL
        AND "rateDate" IS NOT NULL
      )
    ),
    CONSTRAINT "treatment_plan_repricings_validity_check" CHECK (
      ("quoteIssuedOn" IS NULL) = ("quoteValidUntil" IS NULL)
      AND ("quoteValidUntil" IS NULL OR "quoteValidUntil" > "quoteIssuedOn")
      AND (NOT "validityRenewed" OR "quoteIssuedOn" IS NOT NULL)
      AND ("previousQuoteIssuedOn" IS NULL) = ("previousQuoteValidUntil" IS NULL)
      AND ("previousQuoteValidUntil" IS NULL
           OR "previousQuoteValidUntil" > "previousQuoteIssuedOn")
    ),
    CONSTRAINT "treatment_plan_repricings_lines_check" CHECK (
      jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") > 0
      AND jsonb_typeof("skipped") = 'array'
    ),
    CONSTRAINT "treatment_plan_repricings_totals_check" CHECK (
      "totalBefore" >= 0 AND "totalAfter" >= 0
    )
);

-- Una clave por clínica: el replay de /reprice/apply la busca aquí.
CREATE UNIQUE INDEX "treatment_plan_repricings_idempotency_key"
  ON "treatment_plan_repricings"("tenantId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
-- Historial de un plan (y lado hijo de la FK compuesta).
CREATE INDEX "treatment_plan_repricings_plan_idx"
  ON "treatment_plan_repricings"("tenantId", "planId", "patientId", "createdAt");
CREATE INDEX "treatment_plan_repricings_location_idx"
  ON "treatment_plan_repricings"("tenantId", "locationId");
CREATE INDEX "treatment_plan_repricings_actor_idx"
  ON "treatment_plan_repricings"("actorUserId");

ALTER TABLE "treatment_plan_repricings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_repricings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "treatment_plan_repricings"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Registro de evidencia: la app inserta y lee; nunca cambia ni borra. Los
-- privilegios por defecto le dan además UPDATE y DELETE: se quitan.
GRANT SELECT, INSERT ON "treatment_plan_repricings" TO dentalix_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "treatment_plan_repricings" FROM dentalix_app;

CREATE FUNCTION public."treatment_plan_repricings_append_only"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'treatment_plan_repricings es de solo alta: una recotización no se modifica'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- La purga de la clínica (owner, sin clínica en contexto) sí borra.
  IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
    RAISE EXCEPTION 'treatment_plan_repricings es de solo alta: una recotización no se borra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "treatment_plan_repricings_append_only"
  BEFORE UPDATE OR DELETE ON "treatment_plan_repricings"
  FOR EACH ROW EXECUTE FUNCTION public."treatment_plan_repricings_append_only"();

-- ¿Puede esta transacción reescribir la foto del precio de un ítem? Solo la
-- recotización (marca `app.plan_item_reprice`), solo un ítem PROPUESTO, vivo y
-- que no sea el cargo vigente por inasistencia de una cita (SEC-050), y solo
-- en un plan abierto: DRAFT o PRESENTED, vivo y sin aceptación firmada. Lee
-- el plan y los cargos con la RLS de quien escribe (su misma clínica).
CREATE FUNCTION public."treatment_plan_item_reprice_allowed"(
  plan_id uuid, item_id uuid, item_status text, item_deleted_at timestamp
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(current_setting('app.plan_item_reprice', true), '') = 'on'
     AND item_status = 'PROPOSED'
     AND item_deleted_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public."cancellation_fees" f
        WHERE f."planItemId" = item_id
          AND f."status"::text = 'CHARGED'
          AND f."voidedAt" IS NULL
     )
     AND EXISTS (
       SELECT 1 FROM public."treatment_plans" p
        WHERE p."id" = plan_id
          AND p."status"::text IN ('DRAFT', 'PRESENTED')
          AND p."deletedAt" IS NULL
     )
     AND NOT EXISTS (
       SELECT 1 FROM public."treatment_plan_acceptances" a
        WHERE a."planId" = plan_id
     );
$$;

-- DX-502 + DX-379 (B): la moneda del catálogo del ítem queda fijada al darlo
-- de alta, salvo el relleno de DX-502 y la recotización de un ítem propuesto
-- de un plan abierto.
CREATE OR REPLACE FUNCTION public."treatment_plan_items_catalog_currency_frozen"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."catalogCurrency" IS DISTINCT FROM OLD."catalogCurrency"
     AND NOT (OLD."catalogCurrency" IS NULL
              AND coalesce(current_setting('app.dx502_backfill', true), '') = 'on')
     AND NOT (NEW."planId" = OLD."planId"
              AND public."treatment_plan_item_reprice_allowed"(OLD."planId", OLD."id", OLD."status"::text, OLD."deletedAt")) THEN
    RAISE EXCEPTION 'la moneda del catálogo del ítem queda fijada al darlo de alta: no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- DX-513-bis + DX-379 (B): una foto ya escrita no cambia ni se borra, salvo
-- la recotización de un ítem propuesto de un plan abierto (que guarda la
-- anterior en treatment_plan_repricings).
CREATE OR REPLACE FUNCTION public."treatment_plan_items_reference_frozen"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF num_nonnulls(OLD."referenceCurrency", OLD."referencePriceInPlan",
                  OLD."basePriceInPlan", OLD."referenceRateFrom",
                  OLD."referenceRateTo", OLD."referenceRateSource",
                  OLD."referenceRateDate") > 0
     AND (NEW."referenceCurrency", NEW."referencePriceInPlan",
          NEW."basePriceInPlan", NEW."referenceRateFrom",
          NEW."referenceRateTo", NEW."referenceRateSource",
          NEW."referenceRateDate")
         IS DISTINCT FROM
         (OLD."referenceCurrency", OLD."referencePriceInPlan",
          OLD."basePriceInPlan", OLD."referenceRateFrom",
          OLD."referenceRateTo", OLD."referenceRateSource",
          OLD."referenceRateDate")
     AND NOT (NEW."planId" = OLD."planId"
              AND public."treatment_plan_item_reprice_allowed"(OLD."planId", OLD."id", OLD."status"::text, OLD."deletedAt")) THEN
    RAISE EXCEPTION 'la referencia del ítem en la moneda del plan queda fijada al escribirla: no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
