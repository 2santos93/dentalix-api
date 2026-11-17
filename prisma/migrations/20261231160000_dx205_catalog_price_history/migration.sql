-- DX-205: subir precios del catálogo en bloque con vista previa y redondeo.
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   catalog_price_batches  un lote de «Actualizar precios» aplicado: criterios
--                          canónicos (JSONB, sin importes de ítems), huella de
--                          la vista previa, Idempotency-Key (única por
--                          clínica) con la huella de la petición, moneda del
--                          catálogo, nº de ítems, totales y autor.
--   catalog_price_history  cada cambio del precio por defecto de un ítem:
--                          antes, después, lote (NULL = edición suelta),
--                          autor y fecha.
-- Las dos son de SOLO ALTA (append-only): la app inserta y lee; un trigger
-- rechaza UPDATE siempre y DELETE con clínica en contexto (la purga del owner,
-- sin clínica, sí borra), y se revocan UPDATE/DELETE/TRUNCATE a dentalix_app
-- (prisma/append-only-tables.ts y docker/prod/create-app-role.sql).
--
-- FK directa a tenants con RESTRICT (DX-148) y FK COMPUESTAS por clínica
-- (SEC-004) hacia el ítem del catálogo y el lote: un historial nunca apunta a
-- un ítem de otra clínica. RLS ENABLE + FORCE con la política NULLIF (DX-251).
-- Funciones con search_path fijo y pg_temp al final (SEC-032). Las FK van
-- dentro de los CREATE TABLE (nacen vacías: la validación no lee filas).
-- Ninguna tabla existente cambia (dental_catalog_items ya tiene el único
-- (tenantId, id) de DX-105).
--
-- Vuelta atrás: desplegar la API anterior y
--   DROP TABLE public."catalog_price_history";
--   DROP TABLE public."catalog_price_batches";
--   DROP FUNCTION public."dx_catalog_price_append_only"();

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public."dx_catalog_price_append_only"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% es de solo alta: un cambio de precio no se modifica (DX-205)', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- La purga de la clínica (owner, sin clínica en contexto) sí borra.
  IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
    RAISE EXCEPTION '% es de solo alta: un cambio de precio no se borra (DX-205)', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

-- ---------------------------------------------------------------------------
-- catalog_price_batches
-- ---------------------------------------------------------------------------
CREATE TABLE "catalog_price_batches" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "requestFingerprint" CHAR(64) NOT NULL,
    "previewHash" CHAR(64) NOT NULL,
    "currency" CHAR(3),
    "criteria" JSONB NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "totalBefore" DECIMAL(16,2) NOT NULL,
    "totalAfter" DECIMAL(16,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC'::text, now()),

    CONSTRAINT "catalog_price_batches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "catalog_price_batches_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "catalog_price_batches_actor_fkey"
      FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "catalog_price_batches_hash_check" CHECK (
      "previewHash" ~ '^[0-9a-f]{64}$' AND "requestFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "catalog_price_batches_currency_check" CHECK (
      "currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'
    ),
    -- Un lote cambia al menos un precio y como mucho PRICE_CHANGE_MAX_ITEMS.
    CONSTRAINT "catalog_price_batches_values_check" CHECK (
      "itemCount" BETWEEN 1 AND 2000
      AND "totalBefore" >= 0 AND "totalAfter" >= 0
      AND jsonb_typeof("criteria") = 'object'
    )
);

-- Destino de la FK compuesta del historial (SEC-004).
CREATE UNIQUE INDEX "catalog_price_batches_tenant_id_key"
  ON "catalog_price_batches"("tenantId", "id");
-- Una clave por clínica: la repetición de /apply la busca aquí.
CREATE UNIQUE INDEX "catalog_price_batches_idempotency_key"
  ON "catalog_price_batches"("tenantId", "idempotencyKey");
CREATE INDEX "catalog_price_batches_created_idx"
  ON "catalog_price_batches"("tenantId", "createdAt");
CREATE INDEX "catalog_price_batches_actor_idx"
  ON "catalog_price_batches"("actorUserId");

ALTER TABLE "catalog_price_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog_price_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "catalog_price_batches"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT ON "catalog_price_batches" TO dentalix_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "catalog_price_batches" FROM dentalix_app;

CREATE TRIGGER "catalog_price_batches_append_only"
  BEFORE UPDATE OR DELETE ON "catalog_price_batches"
  FOR EACH ROW EXECUTE FUNCTION public."dx_catalog_price_append_only"();

-- ---------------------------------------------------------------------------
-- catalog_price_history
-- ---------------------------------------------------------------------------
CREATE TABLE "catalog_price_history" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "catalogItemId" UUID NOT NULL,
    "batchId" UUID,
    "actorUserId" UUID NOT NULL,
    "previousPrice" DECIMAL(12,2),
    "newPrice" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC'::text, now()),

    CONSTRAINT "catalog_price_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "catalog_price_history_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "catalog_price_history_item_fkey"
      FOREIGN KEY ("tenantId", "catalogItemId")
      REFERENCES "dental_catalog_items"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "catalog_price_history_batch_fkey"
      FOREIGN KEY ("tenantId", "batchId")
      REFERENCES "catalog_price_batches"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "catalog_price_history_actor_fkey"
      FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Un cambio de verdad: precios no negativos y distintos. Un lote nunca
    -- quita ni pone un precio desde cero (solo la edición suelta).
    CONSTRAINT "catalog_price_history_values_check" CHECK (
      ("previousPrice" IS NULL OR "previousPrice" >= 0)
      AND ("newPrice" IS NULL OR "newPrice" >= 0)
      AND "previousPrice" IS DISTINCT FROM "newPrice"
      AND ("batchId" IS NULL OR ("previousPrice" IS NOT NULL AND "newPrice" IS NOT NULL))
    )
);

-- El historial de un ítem (y lado hijo de la FK compuesta al ítem).
CREATE INDEX "catalog_price_history_item_idx"
  ON "catalog_price_history"("tenantId", "catalogItemId", "createdAt");
CREATE INDEX "catalog_price_history_batch_idx"
  ON "catalog_price_history"("tenantId", "batchId");
CREATE INDEX "catalog_price_history_actor_idx"
  ON "catalog_price_history"("actorUserId");

ALTER TABLE "catalog_price_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog_price_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "catalog_price_history"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT ON "catalog_price_history" TO dentalix_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "catalog_price_history" FROM dentalix_app;

CREATE TRIGGER "catalog_price_history_append_only"
  BEFORE UPDATE OR DELETE ON "catalog_price_history"
  FOR EACH ROW EXECUTE FUNCTION public."dx_catalog_price_append_only"();
