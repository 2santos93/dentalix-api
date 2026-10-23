-- DX-262: saldo inicial «Saldo migrado» por paciente, importado con la hoja de
-- saldos del importador de pacientes (DX-107).
--
-- Cambios:
--   patient_import_batches  columnas "balance*": la hoja de saldos del lote
--                       (nombre, hash, formato y tamaño del fichero, que NO se
--                       guarda), sus totales del dry-run por moneda, errores y
--                       avisos por fila, y contadores del trabajo y del
--                       deshacer. ADD COLUMN con DEFAULT constante: solo
--                       metadatos (no reescribe la tabla).
--   patient_import_balance_rows  saldos preparados por el dry-run: uno por
--                       paciente (clave del documento) y moneda, ya sumadas
--                       las filas repetidas. El trabajo los convierte en
--                       opening_balances al importar el lote.
--   opening_balances    el «Saldo migrado»: paciente, sede (la del lote),
--                       lote, moneda, importe > 0, fecha de corte (y si es
--                       aproximada: la de la importación), concepto ≤ 200,
--                       quién y cuándo, y su retirada (voidedAt/voidedById,
--                       al deshacer el lote). Uno por (clínica, lote,
--                       paciente, moneda). Inmutable salvo la retirada
--                       (trigger opening_balances_guard). Hoy ningún abono se
--                       le imputa (los abonos van a un plan; DX-051): el
--                       índice único (tenantId, id) queda para esa FK futura,
--                       que bloqueará el deshacer sin tocar su código.
--   patient_ledgers_compute / patient_ledgers_refresh (DX-155, DX-226): el
--                       resumen de la cartera lleva también los saldos
--                       migrados vivos ("openings": [[id, moneda, importe,
--                       'AAAA-MM-DD', aproximada], ...]); un paciente con
--                       saldo migrado debe ("owing") y tiene fila aunque no
--                       tenga planes; si no hay cita atendida, abono ni plan
--                       presentado, la sede de la deuda es la del último saldo
--                       migrado. Mismo nombre, firma y dueño.
--   patient_ledgers_on_opening_balances + 3 triggers por sentencia: recalculan
--                       el resumen de los pacientes que toca cada INSERT,
--                       UPDATE (columnas que cuentan) o DELETE. La importación
--                       inserta por bloques en transacciones cortas: cada
--                       sentencia refresca solo a sus pacientes (no hace falta
--                       pausar nada).
--
-- FK COMPUESTAS por tenant (SEC-004), dentro del CREATE TABLE (las tablas
-- nacen vacías: la validación no lee filas; DX-134). RLS ENABLE + FORCE con
-- la política NULLIF (DX-251).
--
-- Compatible hacia atrás: solo AÑADE (dos tablas vacías, columnas con DEFAULT
-- y una clave más en el JSON del resumen, que el código anterior ignora). No
-- hay saldos migrados todavía, así que ninguna fila del resumen cambia: sin
-- backfill, sin NO FORCE y sin leer filas de tablas con FORCE.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- La hoja de saldos del lote
-- ---------------------------------------------------------------------------
ALTER TABLE "patient_import_batches"
  ADD COLUMN "balanceFileName" TEXT,
  ADD COLUMN "balanceFileSha256" CHAR(64),
  ADD COLUMN "balanceFileFormat" "PatientImportFileFormat",
  ADD COLUMN "balanceFileSizeBytes" INTEGER,
  ADD COLUMN "balanceTotalRows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "balanceErrorRows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "balanceMergedRows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "balancePreparedRows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "balanceProcessedRows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "balanceCreatedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "balanceSkippedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "balanceFileTotals" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "balanceValidTotals" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "balanceIssues" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "balanceUndoneCount" INTEGER,
  -- Los mismos topes que la hoja de pacientes (5 MB, 10.000 filas). Las filas
  -- existentes cumplen por los DEFAULT (la validación recorre una tabla de un
  -- lote por importación).
  ADD CONSTRAINT "patient_import_batches_balance_file_check" CHECK (
    ("balanceFileName" IS NULL) = ("balanceFileSha256" IS NULL)
    AND ("balanceFileName" IS NULL) = ("balanceFileFormat" IS NULL)
    AND ("balanceFileName" IS NULL) = ("balanceFileSizeBytes" IS NULL)
    AND ("balanceFileSha256" IS NULL OR "balanceFileSha256" ~ '^[0-9a-f]{64}$')
    AND ("balanceFileName" IS NULL OR char_length("balanceFileName") BETWEEN 1 AND 255)
    AND ("balanceFileSizeBytes" IS NULL OR "balanceFileSizeBytes" BETWEEN 1 AND 5242880)
  ),
  ADD CONSTRAINT "patient_import_batches_balance_totals_check" CHECK (
    "balanceTotalRows" BETWEEN 0 AND 10000
    AND "balanceErrorRows" >= 0 AND "balanceMergedRows" >= 0
    AND "balancePreparedRows" >= 0
    AND "balanceProcessedRows" BETWEEN 0 AND "balancePreparedRows"
    AND "balanceCreatedCount" >= 0 AND "balanceSkippedCount" >= 0
    AND ("balanceUndoneCount" IS NULL OR "balanceUndoneCount" >= 0)
    AND jsonb_typeof("balanceFileTotals") = 'array'
    AND jsonb_typeof("balanceValidTotals") = 'array'
    AND jsonb_typeof("balanceIssues") = 'array'
  );

-- ---------------------------------------------------------------------------
-- Saldos preparados por el dry-run
-- ---------------------------------------------------------------------------
CREATE TABLE "patient_import_balance_rows" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "docKey" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "asOfDate" DATE,
    "concept" TEXT,
    "sourceRows" INTEGER NOT NULL DEFAULT 1,
    "outcome" "PatientImportRowOutcome" NOT NULL DEFAULT 'PENDING',
    "patientId" UUID,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "patient_import_balance_rows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_import_balance_rows_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_import_balance_rows_batch_fkey"
      FOREIGN KEY ("tenantId", "batchId") REFERENCES "patient_import_batches"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_import_balance_rows_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_import_balance_rows_values_check" CHECK (
      "rowNumber" BETWEEN 1 AND 1048576
      AND "docKey" ~ '^[0-9A-Z]{1,30}$'
      AND "currency" ~ '^[A-Z]{3}$'
      AND "amount" > 0
      AND "sourceRows" >= 1
      AND ("concept" IS NULL OR char_length("concept") BETWEEN 1 AND 200)
      AND ("asOfDate" IS NULL OR "asOfDate" >= DATE '1900-01-01')
    ),
    -- Creado ⇒ con su paciente; solo PENDING, CREATED, SKIPPED o FAILED.
    CONSTRAINT "patient_import_balance_rows_outcome_check" CHECK (
      "outcome" <> 'FILLED'
      AND ("outcome" <> 'CREATED' OR "patientId" IS NOT NULL)
    )
);

-- Un saldo por paciente y moneda en el lote (y lado hijo de la FK del lote).
CREATE UNIQUE INDEX "patient_import_balance_rows_tenant_batch_doc_key"
  ON "patient_import_balance_rows"("tenantId", "batchId", "docKey", "currency");
-- El trabajo los procesa por bloques: los PENDING del lote en orden de fila.
CREATE INDEX "patient_import_balance_rows_tenant_batch_outcome_idx"
  ON "patient_import_balance_rows"("tenantId", "batchId", "outcome", "rowNumber");
-- Lado hijo de la FK del paciente.
CREATE INDEX "patient_import_balance_rows_tenant_patient_idx"
  ON "patient_import_balance_rows"("tenantId", "patientId");

-- ---------------------------------------------------------------------------
-- Saldo migrado
-- ---------------------------------------------------------------------------
CREATE TABLE "opening_balances" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "importBatchId" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "asOfDate" DATE NOT NULL,
    "asOfDateApproximate" BOOLEAN NOT NULL DEFAULT false,
    "concept" TEXT NOT NULL,
    "sourceRows" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,

    CONSTRAINT "opening_balances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "opening_balances_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "opening_balances_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "opening_balances_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "opening_balances_batch_fkey"
      FOREIGN KEY ("tenantId", "importBatchId") REFERENCES "patient_import_batches"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- La moneda existe en el catálogo `currencies` (DX-042).
    CONSTRAINT "opening_balances_currency_fkey"
      FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "opening_balances_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "opening_balances_values_check" CHECK (
      char_length("concept") BETWEEN 1 AND 200
      AND "asOfDate" >= DATE '1900-01-01'
      AND "sourceRows" >= 1
    ),
    CONSTRAINT "opening_balances_voided_check" CHECK (
      ("voidedAt" IS NULL) = ("voidedById" IS NULL)
    )
);

-- Requisito de una FK compuesta futura (imputación de abonos, DX-051).
CREATE UNIQUE INDEX "opening_balances_tenant_id_key"
  ON "opening_balances"("tenantId", "id");
-- Un saldo por paciente y moneda en cada lote (y lado hijo de la FK del lote).
CREATE UNIQUE INDEX "opening_balances_tenant_batch_patient_currency_key"
  ON "opening_balances"("tenantId", "importBatchId", "patientId", "currency");
-- Estado de cuenta y resumen de la cartera (por paciente); lado hijo de la FK.
CREATE INDEX "opening_balances_tenant_patient_idx"
  ON "opening_balances"("tenantId", "patientId");
-- Lado hijo de la FK de la sede.
CREATE INDEX "opening_balances_tenant_location_idx"
  ON "opening_balances"("tenantId", "locationId");

ALTER TABLE "patient_import_balance_rows" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_import_balance_rows"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "patient_import_balance_rows" FORCE ROW LEVEL SECURITY;

ALTER TABLE "opening_balances" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "opening_balances"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "opening_balances" FORCE ROW LEVEL SECURITY;

-- Inmutable salvo la retirada: un UPDATE solo puede pasar voidedAt y
-- voidedById de NULL a un valor; la app (con contexto de tenant) no borra.
-- Se admiten los DELETE sin contexto de tenant (limpieza del owner).
CREATE FUNCTION public."opening_balances_guard"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(pg_catalog.current_setting('app.current_tenant', true), '') <> '' THEN
      RAISE EXCEPTION 'opening_balances: un saldo migrado no se borra; se retira (voidedAt)'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."voidedAt" IS NOT NULL
     OR NEW."voidedAt" IS NULL
     OR (NEW."id", NEW."tenantId", NEW."locationId", NEW."patientId", NEW."importBatchId",
         NEW."currency", NEW."amount", NEW."asOfDate", NEW."asOfDateApproximate",
         NEW."concept", NEW."sourceRows", NEW."createdById", NEW."createdAt")
        IS DISTINCT FROM
        (OLD."id", OLD."tenantId", OLD."locationId", OLD."patientId", OLD."importBatchId",
         OLD."currency", OLD."amount", OLD."asOfDate", OLD."asOfDateApproximate",
         OLD."concept", OLD."sourceRows", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'opening_balances: un saldo migrado no se modifica; solo se retira una vez'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "opening_balances_guard"
  BEFORE UPDATE OR DELETE ON "opening_balances"
  FOR EACH ROW EXECUTE FUNCTION public."opening_balances_guard"();

-- ---------------------------------------------------------------------------
-- Resumen de la cartera (DX-155): las entradas incluyen los saldos migrados
-- ---------------------------------------------------------------------------
-- Misma forma que en 20261017233000_dx155_patient_ledgers (SQL de una sola
-- sentencia, STABLE, sin SET: se expande en la consulta que la llama), con un
-- LATERAL más sobre opening_balances (índice opening_balances_tenant_patient_idx).
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
         pa."deletedAt" IS NULL AND (COALESCE(pl."owing", false) OR ob."openings" IS NOT NULL),
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
    -- … o la del último saldo migrado vivo (DX-262), que además debe entero.
    LEFT JOIN LATERAL (
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
               o."id", o."currency", o."amount",
               pg_catalog.to_char(o."asOfDate", 'YYYY-MM-DD'), o."asOfDateApproximate")
               ORDER BY o."asOfDate", o."id") AS "openings",
             (pg_catalog.array_agg(o."locationId" ORDER BY o."createdAt" DESC, o."id" DESC))[1]
               AS "locationId"
        FROM public."opening_balances" o
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

-- Mismo cuerpo que en 20261019090000_dx226_server_time_utc_receipt_series,
-- salvo la fila nueva: también para quien tiene un saldo migrado (vivo o no).
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
  -- aunque aún no tenga fila en el resumen; ver DX-155). De paso cuenta
  -- los que ve: un refresco que no ve a los pacientes no puede recalcularlos
  -- y falla en vez de dejar sus filas viejas.
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

  -- Fila para quien tiene algún plan o saldo migrado; en orden, como el
  -- bloqueo de abajo.
  INSERT INTO public."patient_ledgers" ("tenantId", "patientId")
  SELECT DISTINCT k.t, k.p
    FROM ROWS FROM (pg_catalog.unnest(p_tenants), pg_catalog.unnest(p_patients)) AS k(t, p)
   WHERE EXISTS (SELECT 1 FROM public."treatment_plans" tp
                  WHERE tp."tenantId" = k.t AND tp."patientId" = k.p)
      OR EXISTS (SELECT 1 FROM public."opening_balances" o
                  WHERE o."tenantId" = k.t AND o."patientId" = k.p)
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

CREATE FUNCTION public."patient_ledgers_on_opening_balances"() RETURNS trigger
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
     WHERE (o."tenantId", o."patientId", o."locationId", o."currency", o."amount",
            o."asOfDate", o."asOfDateApproximate", o."createdAt", o."voidedAt")
           IS DISTINCT FROM
           (n."tenantId", n."patientId", n."locationId", n."currency", n."amount",
            n."asOfDate", n."asOfDateApproximate", n."createdAt", n."voidedAt");
  END IF;
  PERFORM public."patient_ledgers_refresh"(ts, ps);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "patient_ledgers_opening_balances_insert"
  AFTER INSERT ON "opening_balances"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public."patient_ledgers_on_opening_balances"();
CREATE TRIGGER "patient_ledgers_opening_balances_update"
  AFTER UPDATE ON "opening_balances"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public."patient_ledgers_on_opening_balances"();
CREATE TRIGGER "patient_ledgers_opening_balances_delete"
  AFTER DELETE ON "opening_balances"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public."patient_ledgers_on_opening_balances"();
