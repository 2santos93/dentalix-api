-- DX-226: hora del servidor en UTC (DB-037) y serie de recibos inmutable
-- (DB-038).
--
-- 1. Zona horaria fijada en UTC. Las columnas de hora son `timestamp` SIN
--    zona y Prisma graba en UTC desde el cliente, pero los triggers que ponen
--    la hora del servidor usaban CURRENT_TIMESTAMP, que al guardarse en
--    `timestamp` se convierte a la zona de la SESIÓN: con America/Bogota
--    quedaba 5 h antes. Nada fijaba ni comprobaba la zona.
--      - `ALTER ROLE … SET timezone = 'UTC'` para dentalix_app, el dueño de la
--        base (quien migra), `dentalix_owner` si existe con ese nombre y los
--        roles NOLOGIN dueños de funciones; y `ALTER DATABASE … SET timezone`.
--        Cada uno, si quien migra puede: un owner sin superusuario
--        (`owner-nosu`) no puede tocar un rol que no administra (p. ej. uno
--        superusuario); entonces deja un WARNING y sigue. El de la base lo
--        puede siempre (es su dueño) y cubre a cualquier rol sin valor
--        propio. Solo afecta a sesiones NUEVAS (las réplicas de la API toman
--        UTC al reconectar). `db:check-force` comprueba que dentalix_app
--        arranca en UTC.
--      - Los triggers de hora del servidor graban
--        `pg_catalog.timezone('UTC', pg_catalog.now())`, independiente de la
--        zona de la sesión: historia clínica, adendas, retención, dentición e
--        implantes (dx_clinical_record_server_timestamp), gestiones y
--        compromisos de cobro, recibos y el resumen de la cartera
--        (patient_ledgers_refresh).
--      - El alta de un abono (`payments."createdAt"`) la pone ahora también la
--        BD (trigger BEFORE INSERT nuevo): la regla del compromiso de pago
--        compara el alta del abono con la del compromiso y las dos tienen que
--        venir del MISMO reloj (payment-promise-rule.ts). Un reloj de la API
--        desfasado unos segundos ya no decide si un abono es anterior al
--        compromiso. El UPDATE no se toca.
-- 2. Serie de recibos de la sede ("receiptPrefix", DX-136) inmutable una vez
--    usada. Es la numeración legal del recibo de caja; solo se protegía el
--    valor actual (índice único por clínica).
--      - BEFORE UPDATE OF "receiptPrefix" en `locations`: si la sede tiene
--        recibos o el contador de su serie, el cambio (también a NULL) falla
--        con check_violation. Una sede sin recibos puede cambiarla.
--      - Ninguna sede (alta o cambio) puede tomar una serie que ya tiene
--        recibos o contador en la clínica, aunque la sede que la usó ya no la
--        tenga. Se comprueba contra los recibos y contadores existentes (son
--        inmutables y no se borran salvo un superusuario), bajo el candado
--        consultivo por clínica de DX-216 y con la RLS de quien escribe: la app
--        con su clínica fijada ve todos los de la clínica. La serie derivada
--        de una sede nueva salta también las usadas.
--      - Emitir un recibo retiene la fila de la sede (FOR KEY SHARE) hasta el
--        COMMIT: "receiptPrefix" está en un índice único, así que cambiarla
--        toma FOR UPDATE sobre la fila y espera; al seguir, el trigger ve el
--        recibo confirmado y lo rechaza. Al revés, un recibo que espera a un
--        cambio de serie ya confirmado ve la serie nueva y falla («no es la de
--        la sede»). Los demás UPDATE de la sede no esperan.
--
-- Compatible hacia atrás y sin tocar datos: solo cambia configuración de
-- roles y base, cuerpos de funciones (mismo nombre, firma y dueño) y añade dos
-- funciones y dos triggers. Ninguna fila existente se reescribe (las horas ya
-- grabadas se quedan como están). No lee filas de tablas con FORCE ni quita
-- FORCE. search_path fijo con pg_temp al final y catálogo calificado
-- (SEC-032): son funciones de trigger.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1a. Zona de los roles y de la base
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r name;
BEGIN
  FOR r IN
    SELECT DISTINCT rolname
      FROM pg_catalog.pg_roles
     WHERE rolname IN ('dentalix_app', 'dentalix_owner', 'dentalix_patient_search',
                       'dentalix_email_dispatcher', 'dentalix_membership_lookup')
        OR oid = (SELECT datdba FROM pg_catalog.pg_database
                   WHERE datname = pg_catalog.current_database())
     ORDER BY rolname
  LOOP
    BEGIN
      EXECUTE pg_catalog.format('ALTER ROLE %I SET timezone = %L', r, 'UTC');
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'DX-226: % no puede fijar timezone = UTC en el rol % (lo tiene que hacer un admin: ALTER ROLE % SET timezone = ''UTC''); la base sí queda en UTC',
        current_user, r, r;
    END;
  END LOOP;

  BEGIN
    EXECUTE pg_catalog.format('ALTER DATABASE %I SET timezone = %L',
                              pg_catalog.current_database(), 'UTC');
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE WARNING 'DX-226: % no puede fijar timezone = UTC en la base % (lo tiene que hacer su dueño)',
      current_user, pg_catalog.current_database();
  END;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1b. Hora del servidor en UTC en los triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."dx_clinical_record_server_timestamp"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- UTC sea cual sea la zona de la sesión (DX-226).
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.dx_collection_note_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- La fecha de la gestión la pone el servidor de BD, en UTC (DX-226).
    NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'collection_notes es inalterable: una gestión no se edita ni se borra; una corrección es otra nota (DX-150)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE FUNCTION public.dx_payment_promise_guard() RETURNS trigger
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
    RAISE EXCEPTION 'payment_promises no admite %: un compromiso no se borra (DX-150)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Misma fuente de hora que el alta del abono (DX-226).
    NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'Un compromiso nace abierto (DX-150)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: solo OPEN -> KEPT | BROKEN, una vez, con su hora de cierre.
  IF OLD."status" <> 'OPEN' OR NEW."status" = 'OPEN'
     OR (NEW."id", NEW."tenantId", NEW."patientId", NEW."locationId", NEW."amount",
         NEW."currency", NEW."dueDate", NEW."createdById", NEW."createdAt")
        IS DISTINCT FROM
        (OLD."id", OLD."tenantId", OLD."patientId", OLD."locationId", OLD."amount",
         OLD."currency", OLD."dueDate", OLD."createdById", OLD."createdAt")
  THEN
    RAISE EXCEPTION 'payment_promises es inalterable: un compromiso abierto solo pasa a cumplido o incumplido, una vez (DX-150)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- El alta del abono la pone la BD, como la del compromiso (DX-226). Solo el
-- INSERT: lo que venga en "createdAt" (el reloj de la API) no cuenta.
CREATE FUNCTION public.dx_payment_server_created_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_server_created_at"
  BEFORE INSERT ON "payments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payment_server_created_at();

-- Recibos: hora de emisión en UTC (DX-226) y la fila de la sede retenida
-- hasta el COMMIT (serie inmutable, ver la cabecera).
CREATE OR REPLACE FUNCTION public.dx_payment_receipt_guard() RETURNS trigger
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
    -- La fecha de emisión la pone el servidor de BD, en UTC (DX-226).
    NEW."issuedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
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
    -- FOR KEY SHARE: un cambio de "receiptPrefix" (columna de un índice
    -- único: toma FOR UPDATE) espera a este COMMIT y ve el recibo (DX-226).
    PERFORM 1 FROM public.locations l
     WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."locationId"
       AND l."receiptPrefix" = NEW."seriesPrefix"
       FOR KEY SHARE OF l;
    IF NOT FOUND THEN
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

-- Resumen de la cartera (DX-155): mismo cuerpo, "updatedAt" en UTC.
CREATE OR REPLACE FUNCTION public."patient_ledgers_refresh"(p_tenants uuid[], p_patients uuid[])
  RETURNS void
  LANGUAGE plpgsql
  VOLATILE
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  wanted integer;
  visible integer;
BEGIN
  IF p_tenants IS NULL OR pg_catalog.cardinality(p_tenants) = 0 THEN
    RETURN;
  END IF;

  -- Bloqueo por paciente, en orden, sobre su fila de `patients` (existe
  -- aunque aún no tenga fila en el resumen; ver la cabecera). De paso cuenta
  -- los que ve: un refresco que no ve a los pacientes no puede recalcularlos
  -- y falla en vez de dejar sus filas viejas (ver la cabecera).
  SELECT pg_catalog.count(DISTINCT (k.t, k.p))
    INTO wanted
    FROM ROWS FROM (pg_catalog.unnest(p_tenants), pg_catalog.unnest(p_patients)) AS k(t, p);
  SELECT pg_catalog.count(*)
    INTO visible
    FROM (SELECT 1
            FROM public."patients" pa
            JOIN (SELECT DISTINCT k.t, k.p
                    FROM ROWS FROM (pg_catalog.unnest(p_tenants), pg_catalog.unnest(p_patients)) AS k(t, p)) k
              ON pa."tenantId" = k.t AND pa."id" = k.p
           ORDER BY pa."tenantId", pa."id"
             FOR NO KEY UPDATE OF pa) locked;
  IF visible < wanted THEN
    RAISE EXCEPTION 'patient_ledgers: no se ven % de % pacientes que hay que recalcular (¿escritura sin contexto de tenant con RLS FORCE?)',
      wanted - visible, wanted
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Marca de la transacción para la guarda: estas escrituras son de la BD.
  PERFORM pg_catalog.set_config('dentalix.ledgers_refresh', 'on', true);

  -- Fila para quien tiene algún plan; en orden, como el bloqueo de abajo.
  INSERT INTO public."patient_ledgers" ("tenantId", "patientId")
  SELECT DISTINCT k.t, k.p
    FROM ROWS FROM (pg_catalog.unnest(p_tenants), pg_catalog.unnest(p_patients)) AS k(t, p)
   WHERE EXISTS (SELECT 1 FROM public."treatment_plans" tp
                  WHERE tp."tenantId" = k.t AND tp."patientId" = k.p)
   ORDER BY 1, 2
  ON CONFLICT ("tenantId", "patientId") DO NOTHING;

  PERFORM 1
     FROM public."patient_ledgers" l
     JOIN (SELECT DISTINCT k.t, k.p
             FROM ROWS FROM (pg_catalog.unnest(p_tenants), pg_catalog.unnest(p_patients)) AS k(t, p)) k
       ON l."tenantId" = k.t AND l."patientId" = k.p
    ORDER BY l."tenantId", l."patientId"
      FOR UPDATE OF l;

  -- Sentencia aparte, después del bloqueo: en READ COMMITTED toma una foto
  -- nueva, que ya incluye lo que confirmó quien tenía el bloqueo.
  UPDATE public."patient_ledgers" l
     SET "locationId" = c."locationId",
         "owing" = c."owing",
         "ledger" = c."ledger",
         "updatedAt" = pg_catalog.timezone('UTC', pg_catalog.now())
    FROM (SELECT DISTINCT k.t, k.p
            FROM ROWS FROM (pg_catalog.unnest(p_tenants), pg_catalog.unnest(p_patients)) AS k(t, p)) k
    JOIN public."patient_ledgers_compute"() c
      ON c."tenantId" = k.t AND c."patientId" = k.p
   WHERE l."tenantId" = k.t AND l."patientId" = k.p;

  PERFORM pg_catalog.set_config('dentalix.ledgers_refresh', '', true);
END;
$$;


-- ---------------------------------------------------------------------------
-- 2. Serie de recibos de la sede inmutable una vez usada
-- ---------------------------------------------------------------------------
-- ¿La serie ya numeró recibos en la clínica? Recibos o contador (el contador
-- avanza en la misma transacción que el recibo). Con la RLS de quien llama.
CREATE FUNCTION public.dx_receipt_series_used(p_tenant uuid, p_prefix text)
  RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
           SELECT 1 FROM public.payment_receipt_counters c
            WHERE c."tenantId" = p_tenant AND c."seriesPrefix" = p_prefix)
      OR EXISTS (
           SELECT 1 FROM public.payment_receipts r
            WHERE r."tenantId" = p_tenant AND r."seriesPrefix" = p_prefix)
$$;

-- Serie libre: además de las de las sedes, salta las ya usadas en recibos.
CREATE OR REPLACE FUNCTION public.dx_location_receipt_prefix(p_tenant uuid, p_name text, p_location uuid)
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
  ) OR public.dx_receipt_series_used(p_tenant, candidate) LOOP
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

-- Alta de sede: candado de DX-216; una serie explícita ya usada se rechaza.
CREATE OR REPLACE FUNCTION public.dx_location_default_receipt_prefix() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Una alta o cambio de serie de la clínica a la vez hasta el final de la
  -- transacción.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('dx_location_receipt_prefix'),
    pg_catalog.hashtext(NEW."tenantId"::text)
  );
  IF NEW."receiptPrefix" IS NULL THEN
    NEW."receiptPrefix" := public.dx_location_receipt_prefix(NEW."tenantId", NEW."name", NEW."id");
  ELSIF public.dx_receipt_series_used(NEW."tenantId", NEW."receiptPrefix") THEN
    RAISE EXCEPTION 'La serie % ya se usó en recibos de esta clínica: ninguna otra sede puede tomarla (DX-226)', NEW."receiptPrefix"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Cambio de serie: solo si la sede no ha numerado recibos y la nueva no la
-- usó nadie. También para el superusuario: es la numeración legal.
CREATE FUNCTION public.dx_location_receipt_prefix_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."receiptPrefix" IS NOT DISTINCT FROM OLD."receiptPrefix" THEN
    RETURN NEW;
  END IF;
  -- Mismo candado que el alta: el cambio y el alta de otra sede de la clínica
  -- no eligen a la vez.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('dx_location_receipt_prefix'),
    pg_catalog.hashtext(NEW."tenantId"::text)
  );
  IF EXISTS (
       SELECT 1 FROM public.payment_receipts r
        WHERE r."tenantId" = OLD."tenantId" AND r."locationId" = OLD."id")
     OR (OLD."receiptPrefix" IS NOT NULL
         AND public.dx_receipt_series_used(OLD."tenantId", OLD."receiptPrefix"))
  THEN
    RAISE EXCEPTION 'La sede ya emitió recibos con la serie %: su serie no se puede cambiar (numeración legal del recibo de caja, DX-226)', OLD."receiptPrefix"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."receiptPrefix" IS NOT NULL
     AND public.dx_receipt_series_used(NEW."tenantId", NEW."receiptPrefix")
  THEN
    RAISE EXCEPTION 'La serie % ya se usó en recibos de esta clínica: ninguna otra sede puede tomarla (DX-226)', NEW."receiptPrefix"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "locations_receipt_prefix_guard"
  BEFORE UPDATE OF "receiptPrefix" ON "locations"
  FOR EACH ROW EXECUTE FUNCTION public.dx_location_receipt_prefix_guard();
