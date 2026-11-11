-- DX-015-bis (porción 1): «el reloj lo mueve el procedimiento». DDL.
--
-- Cambios:
--   recall_types           tipo de recall de la clínica: nombre (1–60, único
--                          entre vivos sin distinguir mayúsculas ni espacios
--                          de los extremos), intervalo por defecto (1–36
--                          meses), activo, orden, la clave del enum de
--                          compatibilidad (`systemKey`, uno por clínica) y el
--                          grupo de exclusión (su efecto llega en la porción 2).
--   recall_type_triggers   qué procedimientos del catálogo mueven el reloj de
--                          cada tipo (DONE de un ítem del plan con ese
--                          catalogItemId).
--   patient_recalls        + "recallTypeId" (NULL aquí; lo rellena
--                          20261212090100 y lo cierra 20261212090200),
--                          + "manualDoneAt" (lo que fijó el clínico),
--                          + "lastDoneItemId" (puntero suave al ítem que dio la
--                          base), + "source" (MANUAL | PROCEDURE | BACKFILL,
--                          para poder deshacer el relleno) y + "dueAt",
--                          columna GENERADA: "lastDoneAt" + intervalo (las dos
--                          funciones son IMMUTABLE). Desde aquí "lastDoneAt" es
--                          derivada: greatest("manualDoneAt", día civil del
--                          último DONE de un disparador del tipo). Ya NO la
--                          mueve «cualquier cita atendida» (decisión D1).
--                          "kind" pasa a NULL (deprecado, no se borra el enum:
--                          D7); para los tipos con `systemKey` se sigue
--                          escribiendo igual a esa clave.
--   funciones              dx_recall_seed_default_types (los tres tipos por
--                          defecto: alta de clínica, esta migración y tests),
--                          dx_recall_recompute (la base desde la historia: la
--                          app, el relleno y el seed-demo) y dx_recall_backfill
--                          (solo el relleno de 20261212090100 y sus tests).
--
-- FK COMPUESTAS por tenant (SEC-004) y DENTRO del CREATE TABLE en las tablas
-- nuevas (nacen vacías: el owner sin BYPASSRLS no necesita ver filas, DX-134).
-- La FK nueva de patient_recalls se valida sobre una columna toda NULL.
--
-- Bloqueos: ADD COLUMN … GENERATED ALWAYS … STORED reescribe patient_recalls
-- con ACCESS EXCLUSIVE. Es una tabla pequeña (un recall por paciente y tipo,
-- solo los fijados a mano desde DX-015) y nada la escribe en caliente salvo el
-- PUT del recall; lock_timeout para fallar limpio si algo la retiene.
--
-- Compatible hacia atrás durante el despliegue (la app vieja sigue sirviendo
-- mientras corren las migraciones): ninguna lectura anterior deja de
-- funcionar ("lastDoneAt" sigue ahí; "kind" sigue lleno), y las escrituras de
-- la app vieja las adapta el trigger `patient_recalls_compat_v1`: un alta
-- solo con "kind" recibe su "recallTypeId" (así no la rompe el NOT NULL de
-- 20261212090200 ni lo hace fallar) y un cambio de "lastDoneAt" sin tocar
-- "manualDoneAt" (el PUT viejo) lo copia como lo fijado. Ese trigger se
-- borra en la release siguiente, cuando ya no quede app vieja.
--
-- Grants: ALTER DEFAULT PRIVILEGES cubre a dentalix_app en las tablas nuevas.
-- Las funciones son SECURITY INVOKER (la RLS de quien llama) y solo se dan a
-- dentalix_app las que la app usa.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "RecallSource" AS ENUM ('MANUAL', 'PROCEDURE', 'BACKFILL');

-- ---------------------------------------------------------------------------
-- recall_types
-- ---------------------------------------------------------------------------
CREATE TABLE "recall_types" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "defaultIntervalMonths" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    -- Enlace con el enum de compatibilidad (`PUT …/recalls/HYGIENE`).
    "systemKey" "RecallKind",
    -- Tipos excluyentes entre sí (higiene / mantenimiento periodontal). El
    -- efecto (desactivar el otro) es de la porción 2.
    "exclusionGroup" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "recall_types_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "recall_types_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "recall_types_name_check"
      CHECK (char_length(btrim("name")) BETWEEN 1 AND 60),
    CONSTRAINT "recall_types_interval_check"
      CHECK ("defaultIntervalMonths" BETWEEN 1 AND 36),
    CONSTRAINT "recall_types_exclusion_group_check"
      CHECK ("exclusionGroup" IS NULL OR "exclusionGroup" ~ '^[A-Z][A-Z0-9_]{0,39}$')
);

-- Destino de las FK compuestas.
CREATE UNIQUE INDEX "recall_types_tenant_id_key" ON "recall_types"("tenantId", "id");
-- Un tipo por clave del enum (NULL no cuenta).
CREATE UNIQUE INDEX "recall_types_tenant_system_key_key" ON "recall_types"("tenantId", "systemKey");
-- Nombre único SIN distinguir mayúsculas ni espacios de los extremos, solo
-- entre vivos (como los tipos de cita, DX-133-bis). Prisma no lo expresa.
CREATE UNIQUE INDEX "recall_types_tenant_name_ci_key"
  ON "recall_types"("tenantId", lower(btrim("name"))) WHERE "deletedAt" IS NULL;

-- ---------------------------------------------------------------------------
-- recall_type_triggers
-- ---------------------------------------------------------------------------
CREATE TABLE "recall_type_triggers" (
    "tenantId" UUID NOT NULL,
    "recallTypeId" UUID NOT NULL,
    "catalogItemId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recall_type_triggers_pkey" PRIMARY KEY ("tenantId", "recallTypeId", "catalogItemId"),
    CONSTRAINT "recall_type_triggers_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "recall_type_triggers_type_fkey"
      FOREIGN KEY ("tenantId", "recallTypeId") REFERENCES "recall_types"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "recall_type_triggers_catalog_item_fkey"
      FOREIGN KEY ("tenantId", "catalogItemId") REFERENCES "dental_catalog_items"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

-- «¿Este procedimiento dispara algún tipo?» en la transacción del DONE (y lado
-- hijo de la FK al catálogo).
CREATE INDEX "recall_type_triggers_tenant_catalog_item_idx"
  ON "recall_type_triggers"("tenantId", "catalogItemId");

-- ---------------------------------------------------------------------------
-- patient_recalls
-- ---------------------------------------------------------------------------
-- DX-134: con un owner sin BYPASSRLS, validar una FK sobre una tabla con RLS
-- FORCE la recorre bajo la RLS (y aceptaría huérfanas); se quita FORCE durante
-- el ALTER y se repone abajo, en esta misma transacción. Aquí la columna nace
-- toda NULL, así que no puede haber huérfanas: es la receta por coherencia.
ALTER TABLE "patient_recalls" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "patient_recalls"
  ALTER COLUMN "kind" DROP NOT NULL,
  ADD COLUMN "recallTypeId" UUID,
  ADD COLUMN "manualDoneAt" DATE,
  ADD COLUMN "lastDoneItemId" UUID,
  -- Lo que había fijado el clínico ANTES del relleno, solo si la base
  -- congelada lo movió (la última visita atendida era posterior): entonces
  -- "manualDoneAt" es el día de esa visita, no algo que tecleó nadie. Se
  -- borra en cuanto el clínico vuelve a fijar el recall.
  ADD COLUMN "preBackfillDoneAt" DATE,
  ADD COLUMN "source" "RecallSource" NOT NULL DEFAULT 'MANUAL',
  -- Vencimiento guardado: indexable (20261212090300). Nunca se escribe.
  ADD COLUMN "dueAt" DATE NOT NULL GENERATED ALWAYS AS (("lastDoneAt" + make_interval(months => "intervalMonths"))::date) STORED,
  ADD CONSTRAINT "patient_recalls_type_fkey"
    FOREIGN KEY ("tenantId", "recallTypeId") REFERENCES "recall_types"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Lado hijo de la FK del tipo.
CREATE INDEX "patient_recalls_tenant_type_idx" ON "patient_recalls"("tenantId", "recallTypeId");

-- ---------------------------------------------------------------------------
-- Compatibilidad con la app vieja durante el despliegue (ver la cabecera). Con
-- la RLS de quien escribe: el tipo se busca en su clínica. Ni toca las filas
-- de la app nueva (siempre escribe "recallTypeId") ni el recálculo, que se
-- marca con `dentalix.recall_recompute` mientras escribe.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_patient_recalls_compat_v1() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."recallTypeId" IS NULL AND NEW."kind" IS NOT NULL THEN
    SELECT rt."id" INTO NEW."recallTypeId"
      FROM public."recall_types" rt
     WHERE rt."tenantId" = NEW."tenantId"
       AND rt."systemKey" = NEW."kind";
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."lastDoneAt" IS DISTINCT FROM OLD."lastDoneAt"
     AND NEW."manualDoneAt" IS NOT DISTINCT FROM OLD."manualDoneAt"
     AND OLD."manualDoneAt" IS NOT NULL
     AND coalesce(pg_catalog.current_setting('dentalix.recall_recompute', true), '') <> 'on' THEN
    NEW."manualDoneAt" := NEW."lastDoneAt";
    NEW."preBackfillDoneAt" := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patient_recalls_compat_v1"
  BEFORE INSERT OR UPDATE ON "patient_recalls"
  FOR EACH ROW EXECUTE FUNCTION public.dx_patient_recalls_compat_v1();

-- ---------------------------------------------------------------------------
-- RLS FORCE
-- ---------------------------------------------------------------------------
ALTER TABLE "recall_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recall_type_triggers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "recall_types"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY tenant_isolation ON "recall_type_triggers"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "recall_types" FORCE ROW LEVEL SECURITY;
ALTER TABLE "recall_type_triggers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_recalls" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- dx_recall_seed_default_types: los tres tipos por defecto (D2), globales (sin
-- normas de país): Higiene 6 m ← PREV-PROFILAXIS; Control 12 m ← IMG-CONSULTA;
-- Mantenimiento periodontal 3 m ← PERIO-MANTENIMIENTO y PERIO-RASPADO. Higiene
-- y Mantenimiento periodontal, en el mismo grupo de exclusión. Si la clínica
-- no tiene vivo el ítem de catálogo, el tipo nace sin ese disparador.
-- Idempotente: un tipo que ya existe (por clave o por nombre) no se toca.
-- Con la RLS de quien llama: fija antes app.current_tenant = p_tenant.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_recall_seed_default_types(p_tenant uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  d record;
  v_type uuid;
BEGIN
  FOR d IN
    SELECT * FROM (VALUES
      ('Higiene', 6, 10, 'HYGIENE'::public."RecallKind", 'HYGIENE_PERIO', ARRAY['PREV-PROFILAXIS']),
      ('Control', 12, 20, 'CHECKUP'::public."RecallKind", NULL, ARRAY['IMG-CONSULTA']),
      ('Mantenimiento periodontal', 3, 30, NULL, 'HYGIENE_PERIO', ARRAY['PERIO-MANTENIMIENTO', 'PERIO-RASPADO'])
    ) AS v("name", "months", "sortOrder", "systemKey", "exclusionGroup", "codes")
  LOOP
    SELECT rt."id" INTO v_type
      FROM public."recall_types" rt
     WHERE rt."tenantId" = p_tenant
       AND rt."deletedAt" IS NULL
       AND (rt."systemKey" = d."systemKey" OR lower(btrim(rt."name")) = lower(d."name"))
     LIMIT 1;
    CONTINUE WHEN v_type IS NOT NULL;
    v_type := gen_random_uuid();
    INSERT INTO public."recall_types"
      ("id", "tenantId", "name", "defaultIntervalMonths", "active", "sortOrder",
       "systemKey", "exclusionGroup", "createdAt", "updatedAt")
    VALUES
      (v_type, p_tenant, d."name", d."months", true, d."sortOrder",
       d."systemKey", d."exclusionGroup", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO public."recall_type_triggers" ("tenantId", "recallTypeId", "catalogItemId")
    SELECT p_tenant, v_type, ci."id"
      FROM public."dental_catalog_items" ci
     WHERE ci."tenantId" = p_tenant
       AND ci."deletedAt" IS NULL
       AND ci."code" = ANY (d."codes")
    ON CONFLICT DO NOTHING;
    v_type := NULL;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.dx_recall_seed_default_types(uuid) IS
  'DX-015-bis: tipos de recall por defecto de una clínica (alta, migración y tests). Idempotente.';

-- ---------------------------------------------------------------------------
-- dx_recall_recompute: la base del recall de un paciente y tipo desde la
-- historia. "lastDoneAt" = greatest("manualDoneAt", el día civil más reciente
-- de "completedAt" en la zona de "performedLocationId" de los ítems DONE vivos
-- (plan vivo) con un procedimiento disparador del tipo); "lastDoneItemId" =
-- ese ítem si es el que da la base. Los DONE sin sede, sin fecha o con una
-- sede sin zona no se pueden fechar y se ignoran (nunca una zona por defecto).
-- Si no queda ninguna base, se conserva "lastDoneAt" (D5: no se pierde nada)
-- y se suelta "lastDoneItemId" (ese ítem ya no da la base). Devuelve si
-- cambió algo (la app solo audita entonces).
--
-- Concurrencia: bloquea primero la fila del recall (FOR UPDATE) y DESPUÉS lee
-- los ítems: en READ COMMITTED cada sentencia de una función VOLATILE toma su
-- propia instantánea, así que dos DONE concurrentes del mismo paciente (planes
-- distintos) se serializan aquí y el segundo ve el ítem del primero: queda
-- el máximo.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_recall_recompute(p_tenant uuid, p_patient uuid, p_recall_type uuid)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_recall uuid;
  v_manual date;
  v_day date;
  v_item uuid;
  v_changed integer;
BEGIN
  SELECT pr."id", pr."manualDoneAt" INTO v_recall, v_manual
    FROM public."patient_recalls" pr
   WHERE pr."tenantId" = p_tenant
     AND pr."patientId" = p_patient
     AND pr."recallTypeId" = p_recall_type
     FOR UPDATE;
  IF v_recall IS NULL THEN
    RETURN false;
  END IF;

  SELECT ((i."completedAt" AT TIME ZONE 'UTC') AT TIME ZONE l."timeZone")::date, i."id"
    INTO v_day, v_item
    FROM public."treatment_plan_items" i
    JOIN public."treatment_plans" p
      ON p."tenantId" = i."tenantId" AND p."id" = i."planId" AND p."deletedAt" IS NULL
    JOIN public."recall_type_triggers" t
      ON t."tenantId" = i."tenantId"
     AND t."catalogItemId" = i."catalogItemId"
     AND t."recallTypeId" = p_recall_type
    JOIN public."locations" l
      ON l."tenantId" = i."tenantId" AND l."id" = i."performedLocationId"
   WHERE i."tenantId" = p_tenant
     AND i."patientId" = p_patient
     AND i."status" = 'DONE'
     AND i."deletedAt" IS NULL
     AND i."completedAt" IS NOT NULL
     AND l."timeZone" IS NOT NULL
   ORDER BY 1 DESC, i."completedAt" DESC, i."id" DESC
   LIMIT 1;

  -- El trigger de compatibilidad no toma este cambio por un PUT viejo.
  PERFORM pg_catalog.set_config('dentalix.recall_recompute', 'on', true);
  IF v_day IS NULL AND v_manual IS NULL THEN
    UPDATE public."patient_recalls" pr
       SET "lastDoneItemId" = NULL,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE pr."id" = v_recall
       AND pr."lastDoneItemId" IS NOT NULL;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    PERFORM pg_catalog.set_config('dentalix.recall_recompute', '', true);
    RETURN v_changed > 0;
  END IF;

  UPDATE public."patient_recalls" pr
     SET "lastDoneAt" = greatest(v_manual, v_day),
         "lastDoneItemId" = CASE
           WHEN v_day IS NOT NULL AND (v_manual IS NULL OR v_day >= v_manual) THEN v_item
           ELSE NULL
         END,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE pr."id" = v_recall
     AND (pr."lastDoneAt" IS DISTINCT FROM greatest(v_manual, v_day)
          OR pr."lastDoneItemId" IS DISTINCT FROM CASE
            WHEN v_day IS NOT NULL AND (v_manual IS NULL OR v_day >= v_manual) THEN v_item
            ELSE NULL
          END);
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  PERFORM pg_catalog.set_config('dentalix.recall_recompute', '', true);
  RETURN v_changed > 0;
END;
$$;

COMMENT ON FUNCTION public.dx_recall_recompute(uuid, uuid, uuid) IS
  'DX-015-bis: base del recall (manual o DONE de un disparador, día civil de la sede). La usan la app, el relleno y el seed-demo.';

-- ---------------------------------------------------------------------------
-- dx_recall_backfill: el relleno de UNA clínica (20261212090100 la llama por
-- cada una; los tests, sobre la suya). NO la llama la app. Repetirla es
-- seguro: cada paso solo toca lo que aún no hizo (recalls sin tipo, recalls
-- MANUAL sin "manualDoneAt", pacientes sin recall del tipo); el paso 3 es un
-- recálculo, idempotente.
--   1. "recallTypeId" desde "kind" (vía "systemKey").
--   2. Congela la base que se mostraba ayer, para que nadie entre ni salga de
--      la lista por el cambio de regla: "lastDoneAt" = greatest("lastDoneAt",
--      día civil de la última cita atendida en la zona de SU sede).
--      Reproduce EXACTAMENTE la cuenta de la lista anterior (DX-015/DX-547),
--      también su `coalesce(zona, 'UTC')` para una sede sin zona: no es una
--      zona de reserva nueva, es la regla vieja que se congela (con la zona
--      a secas, esa visita se ignoraría y el paciente entraría en la lista).
--      "manualDoneAt" = esa base congelada: así un CLEAR o un CORRECT
--      posteriores no la deshacen (D5). Si la visita movió la base, lo que
--      había fijado el clínico queda en "preBackfillDoneAt".
--   3. Aplica el historial de DONE de los disparadores (dx_recall_recompute:
--      greatest con lo anterior).
--   4. Crea los recalls (source BACKFILL) de pacientes vivos con un DONE de un
--      disparador de un tipo activo en los últimos p_horizon_months meses
--      (D3: 24) y sin recall de ese tipo, en la sede de ese DONE, con el
--      intervalo por defecto del tipo. Deshacer solo los que nadie tocó:
--      DELETE FROM patient_recalls WHERE source = 'BACKFILL' AND
--      "manualDoneAt" IS NULL (el PUT siempre lo escribe) AND sin
--      recall_contacts.
-- Devuelve cuántos recalls creó.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_recall_backfill(p_tenant uuid, p_horizon_months integer, p_now timestamptz DEFAULT now())
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r record;
  created integer;
BEGIN
  UPDATE public."patient_recalls" pr
     SET "recallTypeId" = rt."id"
    FROM public."recall_types" rt
   WHERE pr."tenantId" = p_tenant
     AND pr."recallTypeId" IS NULL
     AND rt."tenantId" = pr."tenantId"
     AND rt."systemKey" = pr."kind";

  UPDATE public."patient_recalls" pr
     SET "lastDoneAt" = f."base",
         "manualDoneAt" = f."base",
         "preBackfillDoneAt" = CASE
           WHEN f."base" IS DISTINCT FROM pr."lastDoneAt" THEN pr."lastDoneAt"
         END
    FROM (
      SELECT x."id",
             greatest(
               x."lastDoneAt",
               ((lc."start" AT TIME ZONE 'UTC') AT TIME ZONE coalesce(lo."timeZone", 'UTC'))::date
             ) AS "base"
        FROM public."patient_recalls" x
        LEFT JOIN LATERAL (
          SELECT a."start", a."locationId"
            FROM public."appointments" a
           WHERE a."tenantId" = x."tenantId"
             AND a."patientId" = x."patientId"
             AND a."status" = 'COMPLETED'
             AND a."deletedAt" IS NULL
           ORDER BY a."start" DESC, a."id" DESC
           LIMIT 1
        ) lc ON true
        LEFT JOIN public."locations" lo
          ON lo."tenantId" = x."tenantId" AND lo."id" = lc."locationId"
       WHERE x."tenantId" = p_tenant
         AND x."source" = 'MANUAL'
         AND x."manualDoneAt" IS NULL
    ) f
   WHERE pr."id" = f."id";

  -- (El recálculo marca la sesión: el trigger de compatibilidad no lo copia.)
  FOR r IN
    SELECT pr."patientId", pr."recallTypeId"
      FROM public."patient_recalls" pr
     WHERE pr."tenantId" = p_tenant AND pr."recallTypeId" IS NOT NULL
  LOOP
    PERFORM public.dx_recall_recompute(p_tenant, r."patientId", r."recallTypeId");
  END LOOP;

  WITH last_done AS (
    SELECT DISTINCT ON (i."patientId", t."recallTypeId")
           i."patientId", t."recallTypeId", i."id" AS "itemId",
           i."performedLocationId", i."performedById",
           ((i."completedAt" AT TIME ZONE 'UTC') AT TIME ZONE l."timeZone")::date AS "day"
      FROM public."treatment_plan_items" i
      JOIN public."treatment_plans" p
        ON p."tenantId" = i."tenantId" AND p."id" = i."planId" AND p."deletedAt" IS NULL
      JOIN public."patients" pa
        ON pa."tenantId" = i."tenantId" AND pa."id" = i."patientId" AND pa."deletedAt" IS NULL
      JOIN public."recall_type_triggers" t
        ON t."tenantId" = i."tenantId" AND t."catalogItemId" = i."catalogItemId"
      JOIN public."recall_types" rt
        ON rt."tenantId" = t."tenantId" AND rt."id" = t."recallTypeId"
       AND rt."active" AND rt."deletedAt" IS NULL
      JOIN public."locations" l
        ON l."tenantId" = i."tenantId" AND l."id" = i."performedLocationId"
     WHERE i."tenantId" = p_tenant
       AND i."status" = 'DONE'
       AND i."deletedAt" IS NULL
       AND i."completedAt" IS NOT NULL
       AND i."performedById" IS NOT NULL
       AND l."timeZone" IS NOT NULL
       AND i."completedAt" >= ((p_now - make_interval(months => p_horizon_months)) AT TIME ZONE 'UTC')
     ORDER BY i."patientId", t."recallTypeId", 6 DESC, i."completedAt" DESC, i."id" DESC
  )
  INSERT INTO public."patient_recalls"
    ("id", "tenantId", "patientId", "recallTypeId", "kind", "intervalMonths",
     "lastDoneAt", "lastDoneItemId", "locationId", "source",
     "createdById", "updatedById", "createdAt", "updatedAt")
  SELECT gen_random_uuid(), p_tenant, d."patientId", d."recallTypeId", rt."systemKey",
         rt."defaultIntervalMonths", d."day", d."itemId", d."performedLocationId", 'BACKFILL',
         d."performedById", d."performedById", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM last_done d
    JOIN public."recall_types" rt ON rt."tenantId" = p_tenant AND rt."id" = d."recallTypeId"
   WHERE NOT EXISTS (
     SELECT 1 FROM public."patient_recalls" x
      WHERE x."tenantId" = p_tenant
        AND x."patientId" = d."patientId"
        AND x."recallTypeId" = d."recallTypeId"
   );
  GET DIAGNOSTICS created = ROW_COUNT;
  RETURN created;
END;
$$;

COMMENT ON FUNCTION public.dx_recall_backfill(uuid, integer, timestamptz) IS
  'DX-015-bis: relleno de una clínica (solo la migración 20261212090100 y sus tests; nunca la app).';

REVOKE ALL ON FUNCTION public.dx_recall_seed_default_types(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dx_recall_recompute(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dx_recall_backfill(uuid, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dx_patient_recalls_compat_v1() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    GRANT EXECUTE ON FUNCTION public.dx_recall_seed_default_types(uuid) TO dentalix_app;
    GRANT EXECUTE ON FUNCTION public.dx_recall_recompute(uuid, uuid, uuid) TO dentalix_app;
  END IF;
END
$$;
