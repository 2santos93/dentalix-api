-- DX-155: resumen por paciente para la cartera por antigüedad.
--
-- La cartera (GET /receivables/aging, DX-145) reunía en CADA petición, para
-- todos los deudores de la clínica, el facturable de cada plan (todos los
-- ítems de la clínica), lo abonado (todos los abonos), los planes de cuotas y
-- la sede de la deuda (todas las citas atendidas): ~0,45 s de Postgres más
-- ~0,2 s de transferencia con 60k pacientes (docs/perf/DX-145.md). Esta tabla
-- guarda, por paciente, esas ENTRADAS ya reunidas; la BD la mantiene al
-- escribir.
--
--   "locationId"  sede de la deuda: la de la última cita atendida (COMPLETED,
--                 viva); si no hay, la del último abono vivo; si tampoco, la
--                 de la última presentación de un plan; si no, NULL.
--   "owing"       paciente vivo con algún plan vivo cuyo facturable supera lo
--                 abonado en la moneda del plan (superconjunto exacto de quien
--                 debe en `computeBalances`).
--   "ledger"      {"plans": [...], "paymentPlans": [...]} con los planes vivos
--                 del paciente y sus SUMAS (no un saldo) y los planes de
--                 cuotas vivos no cancelados con sus cuotas:
--     plans:        [id, estado, moneda, alta (epoch ms), desde cuándo
--                   envejece (aceptación firmada, presentación o alta; epoch
--                   ms), facturable (Σ precio − Σ descuento de los ítems vivos
--                   ACCEPTED|DONE), abonado vivo en su moneda o null, abonado
--                   vivo en otra moneda [[moneda, importe], ...] o null]
--     paymentPlans: [id, plan, moneda, estado, pie, inicio (epoch ms),
--                   [[secuencia, vencimiento (epoch ms), importe], ...]]
--
-- No es un segundo cálculo del saldo: son las mismas lecturas que hacía la
-- cartera. El saldo, los estados que cuentan, el reparto de abonos en cuotas y
-- los tramos siguen saliendo de `computeBalances` (el núcleo del estado de
-- cuenta) en la aplicación, con el «hoy» de cada petición.
--
-- Mantenimiento: triggers AFTER … FOR EACH STATEMENT (con tablas de
-- transición) en todo lo que cambia esas entradas — treatment_plans,
-- treatment_plan_items, treatment_plan_acceptances, payments, payment_plans,
-- installments, appointments y patients — juntan los pacientes afectados por
-- la sentencia (en un UPDATE, solo si cambió una columna que cuenta) y llaman
-- UNA vez a `patient_ledgers_refresh`, que RECALCULA su fila desde las tablas
-- fuente con `patient_ledgers_compute` (no aplica deltas: volver a llamarla
-- repara una fila). Antes de recalcular bloquea la fila de esos pacientes en
-- `patients` (FOR NO KEY UPDATE: no choca con el FOR KEY SHARE de las FK) y
-- luego su fila del resumen (FOR UPDATE), siempre en orden de tenant y
-- paciente (dos sentencias con varios pacientes no se bloquean en cruz). El
-- bloqueo va sobre `patients` porque esa fila SIEMPRE existe: la del resumen
-- no existe hasta el primer plan, y sin ella una escritura simultánea al alta
-- del primer plan (una cita atendida, retirar al paciente) no esperaría y el
-- alta confirmaría una fila calculada sin ella. Así dos escrituras
-- simultáneas del mismo paciente se ponen en fila y, en READ COMMITTED (el
-- nivel de las escrituras
-- de la app), la sentencia que recalcula toma una foto nueva que ya ve lo que
-- confirmó la otra. En REPEATABLE READ la segunda falla con un error de
-- serialización: nunca un resumen viejo en silencio.
--
-- Hay fila para cada paciente con algún plan (vivo o no); un paciente sin
-- planes no es cartera y no la necesita.
--
-- Los triggers corren con el rol que escribe (dentalix_app, con su
-- `app.current_tenant`), bajo la misma RLS. Si el refresco no ve a un
-- paciente afectado (una escritura sin contexto de tenant de un owner sin
-- superusuario, p. ej. una migración de datos que quitó FORCE solo a la tabla
-- que toca) falla en vez de dejar la fila vieja: esa migración debe quitar
-- FORCE también a patient_ledgers y a las tablas que lee el refresco (README,
-- «Despliegue: roles de la BD»).
--
-- Solo la BD escribe el resumen: un trigger BEFORE rechaza INSERT, UPDATE y
-- DELETE directos hechos con contexto de tenant (la app). Se admiten los del
-- refresco (también llamado a mano para reparar), el CASCADE de las FK y los
-- que no tienen contexto de tenant (owner, limpieza de una base de test).
--
-- Compatible hacia atrás: solo AÑADE (tabla, índices, funciones, triggers). El
-- código anterior no lee la tabla y sus escrituras la mantienen igual.
--
-- Backfill: una sentencia con `patient_ledgers_compute` (la misma función que
-- usa el refresco: una sola definición), con FORCE fuera de las tablas que lee
-- y escribe SOLO durante esta transacción (DX-113: con un owner sin
-- superusuario, FORCE lo sujeta a la RLS y el INSERT … SELECT vería 0 filas).
-- `NO FORCE` toma un ACCESS EXCLUSIVE sobre esas tablas hasta el COMMIT: el
-- despliegue para las escrituras de pacientes, citas, planes y abonos lo que
-- dura (~6 s con 60k pacientes, 42k planes, 28k abonos y 350k citas en la
-- máquina del benchmark de docs/perf/DX-145.md). `lock_timeout`: si una
-- transacción larga las retiene, falla limpia y se reintenta el deploy.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas; el
-- trigger de guarda es quien limita sus escrituras a las del refresco.

SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- Tabla
-- ---------------------------------------------------------------------------
CREATE TABLE "patient_ledgers" (
    "tenantId"   UUID NOT NULL,
    "patientId"  UUID NOT NULL,
    "locationId" UUID,
    "owing"      BOOLEAN NOT NULL DEFAULT false,
    "ledger"     JSONB NOT NULL DEFAULT '{"plans": [], "paymentPlans": []}',
    "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_ledgers_pkey" PRIMARY KEY ("tenantId", "patientId"),
    CONSTRAINT "patient_ledgers_ledger_check" CHECK (
      jsonb_typeof("ledger" -> 'plans') = 'array'
      AND jsonb_typeof("ledger" -> 'paymentPlans') = 'array'
    )
);

-- La cartera: deudores de una sede (o de toda la clínica, por el prefijo).
-- Parcial: solo los que deben.
CREATE INDEX "patient_ledgers_owing_idx"
  ON "patient_ledgers" ("tenantId", "locationId")
  WHERE "owing";

-- FK COMPUESTAS por tenant (SEC-004). La hija se crea vacía en esta misma
-- migración, así que la validación no lee filas.
--   Paciente del MISMO tenant. CASCADE: el resumen es del paciente; si se
--   borra de verdad (limpieza de tests), su fila se va con él.
ALTER TABLE "patient_ledgers" ADD CONSTRAINT "patient_ledgers_patient_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
--   Sede del MISMO tenant. Si se borra de verdad (solo limpieza: las citas y
--   abonos que la usan la retienen antes), la fila se queda sin sede.
ALTER TABLE "patient_ledgers" ADD CONSTRAINT "patient_ledgers_location_fkey"
  FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
  ON DELETE SET NULL ("locationId") ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RLS por tenant (mismo patrón que treatment_plan_acceptances).
-- ---------------------------------------------------------------------------
ALTER TABLE "patient_ledgers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_ledgers" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "patient_ledgers"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- Las entradas de cada paciente (UNA definición, para backfill y refresco)
-- ---------------------------------------------------------------------------
-- SQL de una sola sentencia, STABLE, sin SECURITY DEFINER ni SET: Postgres la
-- expande en la consulta que la llama (inlining), así que el filtro por
-- paciente llega a las búsquedas por índice de cada LATERAL
-- (test/patient-ledgers.int-spec.ts lo comprueba). Por eso no fija
-- search_path: todo va con su esquema, y pg_temp nunca se busca para
-- funciones ni operadores (SEC-032).
CREATE FUNCTION "patient_ledgers_compute"()
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
         COALESCE(visit."locationId", paid."locationId", presented."locationId"),
         pa."deletedAt" IS NULL AND COALESCE(pl."owing", false),
         pg_catalog.jsonb_build_object(
           'plans', COALESCE(pl."plans", '[]'::jsonb),
           'paymentPlans', COALESCE(sched."paymentPlans", '[]'::jsonb))
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
    -- … o última presentación de un plan vivo.
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
                 COALESCE(pays."own", 0) AS "paidOwn",
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

-- ---------------------------------------------------------------------------
-- Recalcular pacientes (los arrays van en paralelo: tenant[i], paciente[i])
-- ---------------------------------------------------------------------------
CREATE FUNCTION "patient_ledgers_refresh"(p_tenants uuid[], p_patients uuid[])
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
         "updatedAt" = CURRENT_TIMESTAMP
    FROM (SELECT DISTINCT k.t, k.p
            FROM ROWS FROM (pg_catalog.unnest(p_tenants), pg_catalog.unnest(p_patients)) AS k(t, p)) k
    JOIN public."patient_ledgers_compute"() c
      ON c."tenantId" = k.t AND c."patientId" = k.p
   WHERE l."tenantId" = k.t AND l."patientId" = k.p;

  PERFORM pg_catalog.set_config('dentalix.ledgers_refresh', '', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- Funciones de trigger: qué pacientes toca cada sentencia
-- ---------------------------------------------------------------------------
-- Una por tabla. En UPDATE solo cuentan las filas en las que cambió una
-- columna que entra en el resumen (se emparejan por "id"); de ellas, el
-- paciente de antes y el de después.

CREATE FUNCTION "patient_ledgers_on_patients"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ts uuid[];
  ps uuid[];
BEGIN
  SELECT pg_catalog.array_agg(n."tenantId"), pg_catalog.array_agg(n."id")
    INTO ts, ps
    FROM new_rows n JOIN old_rows o ON o."id" = n."id"
   WHERE o."deletedAt" IS DISTINCT FROM n."deletedAt";
  PERFORM public."patient_ledgers_refresh"(ts, ps);
  RETURN NULL;
END;
$$;

CREATE FUNCTION "patient_ledgers_on_treatment_plans"() RETURNS trigger
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
  ELSIF TG_OP = 'DELETE' THEN
    SELECT pg_catalog.array_agg(o."tenantId"), pg_catalog.array_agg(o."patientId")
      INTO ts, ps FROM old_rows o;
  ELSE
    SELECT pg_catalog.array_agg(k.t), pg_catalog.array_agg(k.p)
      INTO ts, ps
      FROM new_rows n JOIN old_rows o ON o."id" = n."id",
           LATERAL (VALUES (o."tenantId", o."patientId"), (n."tenantId", n."patientId")) AS k(t, p)
     WHERE (o."tenantId", o."patientId", o."status", o."currency", o."createdAt",
            o."presentedAt", o."presentedLocationId", o."deletedAt")
           IS DISTINCT FROM
           (n."tenantId", n."patientId", n."status", n."currency", n."createdAt",
            n."presentedAt", n."presentedLocationId", n."deletedAt");
  END IF;
  PERFORM public."patient_ledgers_refresh"(ts, ps);
  RETURN NULL;
END;
$$;

-- Las aceptaciones son inmutables (solo INSERT, y DELETE de limpieza).
CREATE FUNCTION "patient_ledgers_on_acceptances"() RETURNS trigger
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

-- Los ítems no llevan paciente: el de su plan. Si el plan ya no existe (se
-- borra en la misma limpieza), su propio trigger recalcula al paciente.
CREATE FUNCTION "patient_ledgers_on_plan_items"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ts uuid[];
  ps uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT pg_catalog.array_agg(tp."tenantId"), pg_catalog.array_agg(tp."patientId")
      INTO ts, ps
      FROM (SELECT DISTINCT n."tenantId", n."planId" FROM new_rows n) k
      JOIN public."treatment_plans" tp ON tp."tenantId" = k."tenantId" AND tp."id" = k."planId";
  ELSIF TG_OP = 'DELETE' THEN
    SELECT pg_catalog.array_agg(tp."tenantId"), pg_catalog.array_agg(tp."patientId")
      INTO ts, ps
      FROM (SELECT DISTINCT o."tenantId", o."planId" FROM old_rows o) k
      JOIN public."treatment_plans" tp ON tp."tenantId" = k."tenantId" AND tp."id" = k."planId";
  ELSE
    SELECT pg_catalog.array_agg(tp."tenantId"), pg_catalog.array_agg(tp."patientId")
      INTO ts, ps
      FROM (SELECT DISTINCT k.t, k.plan
              FROM new_rows n JOIN old_rows o ON o."id" = n."id",
                   LATERAL (VALUES (o."tenantId", o."planId"), (n."tenantId", n."planId")) AS k(t, plan)
             WHERE (o."tenantId", o."planId", o."price", o."discount", o."status", o."deletedAt")
                   IS DISTINCT FROM
                   (n."tenantId", n."planId", n."price", n."discount", n."status", n."deletedAt")) k
      JOIN public."treatment_plans" tp ON tp."tenantId" = k.t AND tp."id" = k.plan;
  END IF;
  PERFORM public."patient_ledgers_refresh"(ts, ps);
  RETURN NULL;
END;
$$;

CREATE FUNCTION "patient_ledgers_on_payments"() RETURNS trigger
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
  ELSIF TG_OP = 'DELETE' THEN
    SELECT pg_catalog.array_agg(o."tenantId"), pg_catalog.array_agg(o."patientId")
      INTO ts, ps FROM old_rows o;
  ELSE
    SELECT pg_catalog.array_agg(k.t), pg_catalog.array_agg(k.p)
      INTO ts, ps
      FROM new_rows n JOIN old_rows o ON o."id" = n."id",
           LATERAL (VALUES (o."tenantId", o."patientId"), (n."tenantId", n."patientId")) AS k(t, p)
     WHERE (o."tenantId", o."patientId", o."treatmentPlanId", o."amount", o."currency",
            o."deletedAt", o."locationId", o."paidAt")
           IS DISTINCT FROM
           (n."tenantId", n."patientId", n."treatmentPlanId", n."amount", n."currency",
            n."deletedAt", n."locationId", n."paidAt");
  END IF;
  PERFORM public."patient_ledgers_refresh"(ts, ps);
  RETURN NULL;
END;
$$;

CREATE FUNCTION "patient_ledgers_on_payment_plans"() RETURNS trigger
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
  ELSIF TG_OP = 'DELETE' THEN
    SELECT pg_catalog.array_agg(o."tenantId"), pg_catalog.array_agg(o."patientId")
      INTO ts, ps FROM old_rows o;
  ELSE
    SELECT pg_catalog.array_agg(k.t), pg_catalog.array_agg(k.p)
      INTO ts, ps
      FROM new_rows n JOIN old_rows o ON o."id" = n."id",
           LATERAL (VALUES (o."tenantId", o."patientId"), (n."tenantId", n."patientId")) AS k(t, p)
     WHERE (o."tenantId", o."patientId", o."treatmentPlanId", o."currency", o."status",
            o."downPayment", o."startDate", o."deletedAt")
           IS DISTINCT FROM
           (n."tenantId", n."patientId", n."treatmentPlanId", n."currency", n."status",
            n."downPayment", n."startDate", n."deletedAt");
  END IF;
  PERFORM public."patient_ledgers_refresh"(ts, ps);
  RETURN NULL;
END;
$$;

-- Las cuotas no llevan paciente: el de su plan de pagos.
CREATE FUNCTION "patient_ledgers_on_installments"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ts uuid[];
  ps uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT pg_catalog.array_agg(pp."tenantId"), pg_catalog.array_agg(pp."patientId")
      INTO ts, ps
      FROM (SELECT DISTINCT n."tenantId", n."paymentPlanId" FROM new_rows n) k
      JOIN public."payment_plans" pp ON pp."tenantId" = k."tenantId" AND pp."id" = k."paymentPlanId";
  ELSIF TG_OP = 'DELETE' THEN
    SELECT pg_catalog.array_agg(pp."tenantId"), pg_catalog.array_agg(pp."patientId")
      INTO ts, ps
      FROM (SELECT DISTINCT o."tenantId", o."paymentPlanId" FROM old_rows o) k
      JOIN public."payment_plans" pp ON pp."tenantId" = k."tenantId" AND pp."id" = k."paymentPlanId";
  ELSE
    SELECT pg_catalog.array_agg(pp."tenantId"), pg_catalog.array_agg(pp."patientId")
      INTO ts, ps
      FROM (SELECT DISTINCT k.t, k.plan
              FROM new_rows n JOIN old_rows o ON o."id" = n."id",
                   LATERAL (VALUES (o."tenantId", o."paymentPlanId"), (n."tenantId", n."paymentPlanId")) AS k(t, plan)
             WHERE (o."tenantId", o."paymentPlanId", o."sequence", o."dueDate", o."amount")
                   IS DISTINCT FROM
                   (n."tenantId", n."paymentPlanId", n."sequence", n."dueDate", n."amount")) k
      JOIN public."payment_plans" pp ON pp."tenantId" = k.t AND pp."id" = k.plan;
  END IF;
  PERFORM public."patient_ledgers_refresh"(ts, ps);
  RETURN NULL;
END;
$$;

-- Las citas solo deciden la sede de la deuda (la última atendida).
CREATE FUNCTION "patient_ledgers_on_appointments"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ts uuid[];
  ps uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT pg_catalog.array_agg(n."tenantId"), pg_catalog.array_agg(n."patientId")
      INTO ts, ps FROM new_rows n WHERE n."status" = 'COMPLETED';
  ELSIF TG_OP = 'DELETE' THEN
    SELECT pg_catalog.array_agg(o."tenantId"), pg_catalog.array_agg(o."patientId")
      INTO ts, ps FROM old_rows o WHERE o."status" = 'COMPLETED';
  ELSE
    SELECT pg_catalog.array_agg(k.t), pg_catalog.array_agg(k.p)
      INTO ts, ps
      FROM new_rows n JOIN old_rows o ON o."id" = n."id",
           LATERAL (VALUES (o."tenantId", o."patientId"), (n."tenantId", n."patientId")) AS k(t, p)
     WHERE (o."status" = 'COMPLETED' OR n."status" = 'COMPLETED')
       AND (o."tenantId", o."patientId", o."status", o."start", o."locationId", o."deletedAt")
           IS DISTINCT FROM
           (n."tenantId", n."patientId", n."status", n."start", n."locationId", n."deletedAt");
  END IF;
  PERFORM public."patient_ledgers_refresh"(ts, ps);
  RETURN NULL;
END;
$$;

-- Solo la BD escribe el resumen (ver la cabecera). Es una red contra código
-- de la app que escriba cifras a mano, no una frontera frente a SQL
-- arbitrario (que podría fijar la marca).
CREATE FUNCTION "patient_ledgers_guard"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF pg_catalog.pg_trigger_depth() = 1
     AND COALESCE(pg_catalog.current_setting('dentalix.ledgers_refresh', true), '') <> 'on'
     AND COALESCE(pg_catalog.current_setting('app.current_tenant', true), '') <> '' THEN
    RAISE EXCEPTION 'patient_ledgers lo mantiene la base de datos: no se escribe directamente'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- ---------------------------------------------------------------------------
-- Backfill (con FORCE fuera solo en esta transacción; ver la cabecera). Un
-- paciente sin planes no tiene fila (ver la cabecera).
-- ---------------------------------------------------------------------------
ALTER TABLE "patients" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "payments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plans" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_items" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_acceptances" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_plans" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "installments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_ledgers" NO FORCE ROW LEVEL SECURITY;
SET LOCAL row_security = off;

INSERT INTO "patient_ledgers" ("tenantId", "patientId", "locationId", "owing", "ledger")
SELECT c."tenantId", c."patientId", c."locationId", c."owing", c."ledger"
  FROM "patient_ledgers_compute"() c
 WHERE EXISTS (SELECT 1 FROM "treatment_plans" tp
                WHERE tp."tenantId" = c."tenantId" AND tp."patientId" = c."patientId");

SET LOCAL row_security = on;
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plans" FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_acceptances" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_plans" FORCE ROW LEVEL SECURITY;
ALTER TABLE "installments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_ledgers" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Triggers (después del backfill: lo que entre a partir de aquí lo mantienen
-- ellos; el ACCESS EXCLUSIVE de arriba impide escrituras entre medias). Una
-- tabla de transición solo vale para un evento: tres triggers por tabla.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "patient_ledgers_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "patient_ledgers"
  FOR EACH ROW EXECUTE FUNCTION "patient_ledgers_guard"();

CREATE TRIGGER "patient_ledgers_patients_update"
  AFTER UPDATE ON "patients"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_patients"();

CREATE TRIGGER "patient_ledgers_treatment_plans_insert"
  AFTER INSERT ON "treatment_plans"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_treatment_plans"();
CREATE TRIGGER "patient_ledgers_treatment_plans_update"
  AFTER UPDATE ON "treatment_plans"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_treatment_plans"();
CREATE TRIGGER "patient_ledgers_treatment_plans_delete"
  AFTER DELETE ON "treatment_plans"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_treatment_plans"();

CREATE TRIGGER "patient_ledgers_acceptances_insert"
  AFTER INSERT ON "treatment_plan_acceptances"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_acceptances"();
CREATE TRIGGER "patient_ledgers_acceptances_delete"
  AFTER DELETE ON "treatment_plan_acceptances"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_acceptances"();

CREATE TRIGGER "patient_ledgers_plan_items_insert"
  AFTER INSERT ON "treatment_plan_items"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_plan_items"();
CREATE TRIGGER "patient_ledgers_plan_items_update"
  AFTER UPDATE ON "treatment_plan_items"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_plan_items"();
CREATE TRIGGER "patient_ledgers_plan_items_delete"
  AFTER DELETE ON "treatment_plan_items"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_plan_items"();

CREATE TRIGGER "patient_ledgers_payments_insert"
  AFTER INSERT ON "payments"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_payments"();
CREATE TRIGGER "patient_ledgers_payments_update"
  AFTER UPDATE ON "payments"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_payments"();
CREATE TRIGGER "patient_ledgers_payments_delete"
  AFTER DELETE ON "payments"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_payments"();

CREATE TRIGGER "patient_ledgers_payment_plans_insert"
  AFTER INSERT ON "payment_plans"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_payment_plans"();
CREATE TRIGGER "patient_ledgers_payment_plans_update"
  AFTER UPDATE ON "payment_plans"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_payment_plans"();
CREATE TRIGGER "patient_ledgers_payment_plans_delete"
  AFTER DELETE ON "payment_plans"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_payment_plans"();

CREATE TRIGGER "patient_ledgers_installments_insert"
  AFTER INSERT ON "installments"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_installments"();
CREATE TRIGGER "patient_ledgers_installments_update"
  AFTER UPDATE ON "installments"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_installments"();
CREATE TRIGGER "patient_ledgers_installments_delete"
  AFTER DELETE ON "installments"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_installments"();

CREATE TRIGGER "patient_ledgers_appointments_insert"
  AFTER INSERT ON "appointments"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_appointments"();
CREATE TRIGGER "patient_ledgers_appointments_update"
  AFTER UPDATE ON "appointments"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_appointments"();
CREATE TRIGGER "patient_ledgers_appointments_delete"
  AFTER DELETE ON "appointments"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "patient_ledgers_on_appointments"();
