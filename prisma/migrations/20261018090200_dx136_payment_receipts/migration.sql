-- DX-136: recibo de caja por abono, con numeración consecutiva por sede.
--
-- Cambios:
--   locations."receiptPrefix"
--       serie de recibos de la sede (2 a 6 caracteres, p. ej. "NOR"). Opcional
--       en el esquema, pero un trigger la deriva al crear la sede si no viene:
--       3 letras del nombre sin tildes ni palabras genéricas ("Sede", "Clínica",
--       "de"...) en mayúsculas, y si ya la usa otra sede de la clínica, con un
--       número detrás ("NOR2"). Única por clínica e incluye las sedes
--       retiradas: una serie nunca se reutiliza. Las sedes existentes se
--       rellenan aquí, por orden de alta (DX-019 dará la pantalla para fijarla).
--   payment_receipt_counters
--       último número emitido por serie. La API lo incrementa con un UPSERT
--       en la MISMA transacción que el abono: el bloqueo de la fila ordena las
--       emisiones concurrentes (sin duplicados) y un rollback deshace el
--       incremento (sin huecos). Solo puede avanzar de uno en uno (trigger).
--   payment_receipts
--       un recibo por abono (paymentId único): serie, número, quién y cuándo
--       lo emitió y la foto (snapshot jsonb) de lo que se imprime. Inmutable:
--       un trigger solo deja marcarlo ANULADO una vez (fecha, quién y motivo);
--       nunca DELETE ni TRUNCATE salvo un superusuario (limpieza de las bases
--       de test, como audit_events y la historia clínica). El número tiene que
--       ser el del contador de su serie en ese momento y la serie, la de la
--       sede: nada puede saltarse el contador. El abono tiene que ser de la
--       misma clínica y de esa sede (trigger, bajo la RLS de quien inserta).
--
-- Los abonos anteriores no tienen recibo y NO se renumeran: la API los
-- muestra con su referencia antigua (REC-xxxxxxxx) y «sin serie».
--
-- Compatible hacia atrás: la columna nueva es opcional y el código anterior no
-- la lee; las tablas nuevas nacen vacías. El único dato que se toca es el
-- relleno de "receiptPrefix", con FORCE quitado a `locations` en esta misma
-- transacción y devuelto al final (regla de DX-113 para un owner sin
-- superusuario ni BYPASSRLS). Las FK nuevas salen de tablas creadas aquí
-- (vacías), así que no hace falta quitar FORCE a las referenciadas (DX-134).
-- No se toca `payments` (ni índices nuevos ni bloqueos sobre ella).
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en las tablas
-- nuevas (igual que 20261017210100_dx122_schedule_blocks_waitlist).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Serie de la sede
-- ---------------------------------------------------------------------------
ALTER TABLE "locations" ADD COLUMN "receiptPrefix" TEXT;

-- Base de la serie: 3 letras del nombre sin tildes, sin palabras genéricas y
-- en mayúsculas ("Sede Norte" -> "NOR", "Sede principal" -> "PRI"). Si el
-- nombre no tiene al menos 2 letras útiles, "SED".
CREATE FUNCTION public.dx_receipt_prefix_base(location_name text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH words AS (
    SELECT w, ord
      FROM pg_catalog.regexp_split_to_table(
             COALESCE(public.dx_search_normalize(location_name), ''),
             '[^a-z0-9]+') WITH ORDINALITY AS t(w, ord)
     WHERE w <> ''
  ),
  significant AS (
    SELECT w, ord FROM words
     WHERE w NOT IN ('sede', 'clinica', 'consultorio', 'sucursal', 'centro',
                     'de', 'del', 'la', 'el', 'los', 'las', 'y')
  ),
  letters AS (
    SELECT pg_catalog.regexp_replace(
             COALESCE(NULLIF((SELECT pg_catalog.string_agg(w, '' ORDER BY ord) FROM significant), ''),
                      (SELECT pg_catalog.string_agg(w, '' ORDER BY ord) FROM words),
                      ''),
             '[^a-z]', '', 'g') AS l
  )
  SELECT CASE WHEN pg_catalog.length(l) >= 2
              THEN pg_catalog.upper(pg_catalog.left(l, 3))
              ELSE 'SED' END
    FROM letters
$$;

-- Serie libre para una sede de la clínica: la base, o la base con un número
-- (2..999) si otra sede de la clínica ya la usa. Lee `locations` con la RLS
-- de quien la llama (la app, con su clínica fijada; la migración, sin FORCE).
CREATE FUNCTION public.dx_location_receipt_prefix(p_tenant uuid, p_name text, p_location uuid)
  RETURNS text
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  base text := public.dx_receipt_prefix_base(p_name);
  candidate text := base;
  n integer := 1;
BEGIN
  WHILE EXISTS (
    SELECT 1 FROM public.locations
     WHERE "tenantId" = p_tenant
       AND "receiptPrefix" = candidate
       AND id IS DISTINCT FROM p_location
  ) LOOP
    n := n + 1;
    IF n > 999 THEN
      RAISE EXCEPTION 'No queda serie de recibos libre para la sede "%"', p_name
        USING ERRCODE = 'unique_violation';
    END IF;
    candidate := base || n::text;
  END LOOP;
  RETURN candidate;
END;
$$;

CREATE FUNCTION public.dx_location_default_receipt_prefix() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."receiptPrefix" IS NULL THEN
    NEW."receiptPrefix" := public.dx_location_receipt_prefix(NEW."tenantId", NEW."name", NEW."id");
  END IF;
  RETURN NEW;
END;
$$;

-- Relleno de las sedes existentes, por orden de alta dentro de cada clínica
-- (la primera se queda la base; las siguientes que choquen, con número).
ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT "id", "tenantId", "name" FROM public.locations
     WHERE "receiptPrefix" IS NULL
     ORDER BY "tenantId", "createdAt", "id"
  LOOP
    UPDATE public.locations
       SET "receiptPrefix" = public.dx_location_receipt_prefix(r."tenantId", r."name", r."id")
     WHERE "id" = r."id";
  END LOOP;
END;
$$;

ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;

ALTER TABLE "locations" ADD CONSTRAINT "locations_receipt_prefix_check"
  CHECK ("receiptPrefix" IS NULL OR "receiptPrefix" ~ '^[A-Z][A-Z0-9]{1,5}$');

-- Única por clínica, también entre sedes retiradas: una serie no se reutiliza.
CREATE UNIQUE INDEX "locations_tenant_receipt_prefix_key"
  ON "locations"("tenantId", "receiptPrefix");

CREATE TRIGGER "locations_default_receipt_prefix"
  BEFORE INSERT ON "locations"
  FOR EACH ROW EXECUTE FUNCTION public.dx_location_default_receipt_prefix();

-- ---------------------------------------------------------------------------
-- 2. Contador por serie
-- ---------------------------------------------------------------------------
CREATE TABLE "payment_receipt_counters" (
    "tenantId" UUID NOT NULL,
    "seriesPrefix" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL,

    CONSTRAINT "payment_receipt_counters_pkey" PRIMARY KEY ("tenantId", "seriesPrefix"),
    CONSTRAINT "payment_receipt_counters_last_number_check" CHECK ("lastNumber" > 0)
);

-- CASCADE: el contador es de la clínica y no tiene sentido sin ella (el
-- producto retira clínicas en blando; solo afecta a la limpieza de tests).
ALTER TABLE "payment_receipt_counters" ADD CONSTRAINT "payment_receipt_counters_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Recibos
-- ---------------------------------------------------------------------------
CREATE TABLE "payment_receipts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "seriesPrefix" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" UUID,
    "snapshot" JSONB NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,

    CONSTRAINT "payment_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_receipts_number_check" CHECK ("number" > 0),
    CONSTRAINT "payment_receipts_series_check" CHECK ("seriesPrefix" ~ '^[A-Z][A-Z0-9]{1,5}$'),
    CONSTRAINT "payment_receipts_snapshot_check" CHECK (jsonb_typeof("snapshot") = 'object'),
    -- Anulado = fecha y motivo a la vez (como el abono, SEC-013).
    CONSTRAINT "payment_receipts_void_check" CHECK (
      ("voidedAt" IS NULL AND "voidReason" IS NULL AND "voidedById" IS NULL)
      OR ("voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL)
    )
);

-- Un recibo por abono, y un número por serie de la clínica.
CREATE UNIQUE INDEX "payment_receipts_paymentId_key" ON "payment_receipts"("paymentId");
CREATE UNIQUE INDEX "payment_receipts_tenant_series_number_key"
  ON "payment_receipts"("tenantId", "seriesPrefix", "number");
-- Recibos de una sede por fecha de emisión; también lado hijo de la FK a la sede.
CREATE INDEX "payment_receipts_tenantId_locationId_issuedAt_idx"
  ON "payment_receipts"("tenantId", "locationId", "issuedAt" DESC);

-- DB-028: FK de tenantId explícita en la tabla nueva.
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- FK COMPUESTA (SEC-004): la sede, de la MISMA clínica.
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_tenantId_locationId_fkey"
  FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- El abono, por su clave primaria. Que sea de la MISMA clínica y de ESA sede lo
-- exige el trigger de inserción (abajo), que lo lee bajo la RLS de quien
-- inserta: así no hace falta un índice único nuevo (tenantId, id, locationId)
-- sobre `payments`, que bloquearía la tabla al crearlo y competiría con los
-- índices parciales de la caja en el planificador. CASCADE: el producto nunca
-- borra abonos (se anulan); el borrado en duro solo existe en la limpieza de
-- las bases de test, y el trigger rechaza el borrado del recibo a cualquiera
-- que no sea superusuario (la acción referencial corre como el dueño).
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "payments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Inmutabilidad y coherencia con el abono y el contador (triggers)
--    search_path fijo con pg_temp AL FINAL y pg_catalog.pg_roles calificado:
--    una tabla temporal "pg_roles" del rol de la app no puede declararlo
--    superusuario (SEC-032).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_payment_receipt_guard() RETURNS trigger
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
    RAISE EXCEPTION 'payment_receipts no admite %: un recibo emitido no se borra; se anula el abono (DX-136)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- La fecha de emisión la pone el servidor de BD.
    NEW."issuedAt" := CURRENT_TIMESTAMP;
    IF NEW."voidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Un recibo no se emite ya anulado (DX-136)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.payments p
       WHERE p."id" = NEW."paymentId" AND p."tenantId" = NEW."tenantId"
         AND p."locationId" = NEW."locationId"
    ) THEN
      RAISE EXCEPTION 'El recibo tiene que ser de un abono de la misma clínica y sede (DX-136)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.locations l
       WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."locationId"
         AND l."receiptPrefix" = NEW."seriesPrefix"
    ) THEN
      RAISE EXCEPTION 'La serie % no es la de la sede del abono (DX-136)', NEW."seriesPrefix"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.payment_receipt_counters c
       WHERE c."tenantId" = NEW."tenantId" AND c."seriesPrefix" = NEW."seriesPrefix"
         AND c."lastNumber" = NEW."number"
    ) THEN
      RAISE EXCEPTION 'El número % no es el que acaba de dar el contador de la serie % (DX-136)', NEW."number", NEW."seriesPrefix"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: solo la marca de anulación, una sola vez.
  IF OLD."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'El recibo % ya está anulado: no se puede modificar (DX-136)', OLD."id"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."voidedAt" IS NULL
     OR (NEW."id", NEW."tenantId", NEW."locationId", NEW."paymentId",
         NEW."seriesPrefix", NEW."number", NEW."issuedAt", NEW."issuedById", NEW."snapshot")
        IS DISTINCT FROM
        (OLD."id", OLD."tenantId", OLD."locationId", OLD."paymentId",
         OLD."seriesPrefix", OLD."number", OLD."issuedAt", OLD."issuedById", OLD."snapshot")
  THEN
    RAISE EXCEPTION 'payment_receipts es inalterable: solo se puede marcar un recibo como anulado (DX-136)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_receipts_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "payment_receipts"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payment_receipt_guard();
CREATE TRIGGER "payment_receipts_no_truncate"
  BEFORE TRUNCATE ON "payment_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_payment_receipt_guard();

CREATE FUNCTION public.dx_payment_receipt_counter_guard() RETURNS trigger
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
    RAISE EXCEPTION 'payment_receipt_counters no admite %: un número de recibo nunca se reutiliza (DX-136)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."lastNumber" <> 1 THEN
      RAISE EXCEPTION 'Una serie de recibos empieza en 1 (DX-136)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."tenantId" <> OLD."tenantId"
     OR NEW."seriesPrefix" <> OLD."seriesPrefix"
     OR NEW."lastNumber" <> OLD."lastNumber" + 1
  THEN
    RAISE EXCEPTION 'El contador de recibos solo avanza de uno en uno (DX-136)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_receipt_counters_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "payment_receipt_counters"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payment_receipt_counter_guard();
CREATE TRIGGER "payment_receipt_counters_no_truncate"
  BEFORE TRUNCATE ON "payment_receipt_counters"
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_payment_receipt_counter_guard();

-- ---------------------------------------------------------------------------
-- 5. RLS forzada por clínica (mismo patrón que el resto de tablas de clínica)
-- ---------------------------------------------------------------------------
ALTER TABLE "payment_receipt_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_receipt_counters" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "payment_receipt_counters"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "payment_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_receipts" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "payment_receipts"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
