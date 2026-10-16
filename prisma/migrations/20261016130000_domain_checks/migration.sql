-- DX-042 (DB-010, DB-011, DB-013): reglas de dominio en la BASE.
--
-- Hasta aqui estas reglas solo vivian en los casos de uso. Cualquier camino que
-- no pase por ellos (seed, script, SQL manual, un $executeRaw futuro) podia
-- escribir importes negativos, citas que terminan antes de empezar (tsrange
-- vacio o con error dentro de la EXCLUDE anti-solape), monedas en minusculas o
-- cantidades de inventario a cero. Ahora la base las rechaza con un CHECK con
-- NOMBRE, que es lo que se ve en el error y lo que reconoce el codigo:
--
--   payments_amount_positive                  amount > 0
--   installments_amount_nonneg                amount >= 0 AND sequence >= 1
--   payment_plans_valid_amounts               totalToFinance > 0, 0 <= downPayment
--                                             <= totalToFinance, 1..600 cuotas
--   treatment_plan_items_price_nonneg         price >= 0
--   dental_catalog_items_default_price_nonneg defaultPrice >= 0 (NULL = sin tarifa)
--   appointments_valid_range                  "end" > start
--   inventory_items_minstock_nonneg           minStock >= 0
--   inventory_movements_qty                   IN/OUT > 0; ADJUSTMENT <> 0
--   <tabla>_currency_format                   currency ~ '^[A-Z]{3}$' en payments,
--                                             treatment_plans y payment_plans
--
-- Son exactamente las reglas que ya aplican los casos de uso
-- (RecordPaymentUseCase, CreatePaymentPlanUseCase, generateSchedule,
-- Add/UpdateTreatmentPlanItemUseCase, el catalogo, CreateAppointmentUseCase,
-- RecordInventoryMovementUseCase y las DTO), asi que ninguna escritura valida
-- de la app cambia de resultado.
--
-- Ademas:
--  * DB-011: el unico de nombre de insumo pasa de (tenantId, name) a
--    (tenantId, locationId, lower(name)). Desde multi-sede cada insumo es de una
--    sede (el stock es fisico): dos sedes pueden tener "Guantes nitrilo M", y en
--    la MISMA sede "Guantes" y "guantes" ya no conviven. Sigue siendo PARCIAL
--    (solo vivos), igual que el anterior. Es un indice de EXPRESION, que el DSL
--    de Prisma no expresa ni introspecciona: schema.prisma ya no declara ningun
--    @@unique de nombre en InventoryItem, y migrate diff no lo ve en ningun lado.
--  * DB-013: unico PARCIAL de tooth_records ("tenantId", "sourcePlanItemId")
--    para registros espejados de un item de plan vivo. Respaldo de BD del
--    "como mucho una vez" del espejo DONE -> odontograma; los registros hechos
--    a mano en el odontograma (sourcePlanItemId NULL) no se limitan.
--    schema.prisma lo declara con el mismo nombre y columnas (sin el WHERE, que
--    Prisma no expresa), mismo patron que payments_tenant_idempotency_key.
--
-- Compatible hacia atras y sin perdida: no cambia columnas ni datos, solo
-- anade constraints/indices. Grants/RLS sin cambios (corre con el owner
-- "dentalix", DIRECT_URL).
--
-- Transaccion y locks: Prisma ejecuta el script como UNA transaccion. Antes de
-- la comprobacion previa se bloquean todas las tablas, en orden fijo, para que
-- nadie cuele una fila invalida entre la comprobacion y el ADD CONSTRAINT:
--  * las que reciben un CHECK, directamente en ACCESS EXCLUSIVE, que es lo que
--    pide ADD CONSTRAINT ... CHECK. Si se tomara antes un lock menor (SHARE ROW
--    EXCLUSIVE) habria que ESCALARLO, y una transaccion de la app que ya leyo
--    la tabla y luego quiere escribir en ella interbloquearia con la migracion.
--    Durante esos milisegundos tampoco se lee de esas tablas;
--  * tooth_records solo recibe un CREATE UNIQUE INDEX (lock SHARE): basta
--    SHARE ROW EXCLUSIVE (deja leer, bloquea escrituras) y no escala.
-- lock_timeout: si una transaccion larga retiene alguna tabla, la migracion
-- falla limpia (sin cambios) en vez de esperar con TODO el trafico de la app
-- encolado detras de su peticion de lock; basta con reintentar el deploy.
-- Con volumen: ADD CONSTRAINT ... NOT VALID + VALIDATE CONSTRAINT en otra
-- migracion, y CREATE UNIQUE INDEX CONCURRENTLY fuera de transaccion (ver
-- 20261015130000_tenant_composite_fks).

-- ---------------------------------------------------------------------------
-- 0. row_security = off: con RLS FORCE la comprobacion contaria 0 filas en
--    silencio. Asi, o se ven todas las filas o la migracion falla ("query would
--    be affected by row-level security policy"); en ese caso hay que correrla
--    con un rol superusuario o BYPASSRLS.
-- ---------------------------------------------------------------------------
SET LOCAL row_security = off;

-- ---------------------------------------------------------------------------
-- 0b. Locks (ver arriba).
-- ---------------------------------------------------------------------------
SET LOCAL lock_timeout = '10s';
LOCK TABLE "dental_catalog_items", "treatment_plans", "treatment_plan_items",
  "payments", "payment_plans", "installments", "appointments",
  "inventory_items", "inventory_movements"
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "tooth_records" IN SHARE ROW EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- 1. Pre-flight. Si alguna fila incumple una regla nueva, se aborta con el
--    desglose ANTES de crear nada. NUNCA se borran ni se reescriben datos: hay
--    que revisarlos a mano, `prisma migrate resolve --rolled-back` y reintentar.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad text := '';
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "payments" WHERE NOT ("amount" > 0);
  IF n > 0 THEN bad := bad || format(E'\n  payments.amount > 0: %s', n); END IF;

  SELECT count(*) INTO n FROM "installments" WHERE NOT ("amount" >= 0 AND "sequence" >= 1);
  IF n > 0 THEN bad := bad || format(E'\n  installments.amount >= 0 y sequence >= 1: %s', n); END IF;

  SELECT count(*) INTO n FROM "payment_plans"
   WHERE NOT ("totalToFinance" > 0 AND "downPayment" >= 0
              AND "downPayment" <= "totalToFinance"
              AND "installmentsCount" BETWEEN 1 AND 600);
  IF n > 0 THEN bad := bad || format(E'\n  payment_plans (totalToFinance > 0, 0 <= downPayment <= totalToFinance, 1..600 cuotas): %s', n); END IF;

  SELECT count(*) INTO n FROM "treatment_plan_items" WHERE NOT ("price" >= 0);
  IF n > 0 THEN bad := bad || format(E'\n  treatment_plan_items.price >= 0: %s', n); END IF;

  SELECT count(*) INTO n FROM "dental_catalog_items" WHERE "defaultPrice" < 0;
  IF n > 0 THEN bad := bad || format(E'\n  dental_catalog_items.defaultPrice >= 0: %s', n); END IF;

  SELECT count(*) INTO n FROM "appointments" WHERE NOT ("end" > "start");
  IF n > 0 THEN bad := bad || format(E'\n  appointments.end > start: %s', n); END IF;

  SELECT count(*) INTO n FROM "inventory_items" WHERE NOT ("minStock" >= 0);
  IF n > 0 THEN bad := bad || format(E'\n  inventory_items.minStock >= 0: %s', n); END IF;

  SELECT count(*) INTO n FROM "inventory_movements"
   WHERE NOT (("type" IN ('IN', 'OUT') AND "quantity" > 0)
              OR ("type" = 'ADJUSTMENT' AND "quantity" <> 0));
  IF n > 0 THEN bad := bad || format(E'\n  inventory_movements.quantity (IN/OUT > 0, ADJUSTMENT <> 0): %s', n); END IF;

  SELECT count(*) INTO n FROM "payments" WHERE "currency" !~ '^[A-Z]{3}$';
  IF n > 0 THEN bad := bad || format(E'\n  payments.currency ^[A-Z]{3}$: %s', n); END IF;

  SELECT count(*) INTO n FROM "treatment_plans" WHERE "currency" !~ '^[A-Z]{3}$';
  IF n > 0 THEN bad := bad || format(E'\n  treatment_plans.currency ^[A-Z]{3}$: %s', n); END IF;

  SELECT count(*) INTO n FROM "payment_plans" WHERE "currency" !~ '^[A-Z]{3}$';
  IF n > 0 THEN bad := bad || format(E'\n  payment_plans.currency ^[A-Z]{3}$: %s', n); END IF;

  SELECT count(*) INTO n FROM (
    SELECT 1 FROM "inventory_items" WHERE "deletedAt" IS NULL
     GROUP BY "tenantId", "locationId", lower("name") HAVING count(*) > 1
  ) d;
  IF n > 0 THEN bad := bad || format(E'\n  inventory_items (tenantId, locationId, lower(name)) duplicados: %s', n); END IF;

  SELECT count(*) INTO n FROM (
    SELECT 1 FROM "tooth_records"
     WHERE "sourcePlanItemId" IS NOT NULL AND "deletedAt" IS NULL
     GROUP BY "tenantId", "sourcePlanItemId" HAVING count(*) > 1
  ) d;
  IF n > 0 THEN bad := bad || format(E'\n  tooth_records (tenantId, sourcePlanItemId) duplicados: %s', n); END IF;

  IF bad <> '' THEN
    RAISE EXCEPTION 'DX-042: hay filas que incumplen las reglas de dominio nuevas. No se crea ninguna constraint ni se toca ningun dato. Filas (o grupos duplicados) por regla:%', bad
      USING HINT = 'Revisa y corrige esas filas a mano, marca la migracion con prisma migrate resolve --rolled-back 20261016130000_domain_checks y vuelve a ejecutar prisma migrate deploy.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. CHECK de importes, cuotas, cantidades, rango de cita y moneda.
-- ---------------------------------------------------------------------------
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "payments_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "installments"
  ADD CONSTRAINT "installments_amount_nonneg" CHECK ("amount" >= 0 AND "sequence" >= 1);

ALTER TABLE "payment_plans"
  ADD CONSTRAINT "payment_plans_valid_amounts" CHECK (
    "totalToFinance" > 0
    AND "downPayment" >= 0
    AND "downPayment" <= "totalToFinance"
    AND "installmentsCount" BETWEEN 1 AND 600
  ),
  ADD CONSTRAINT "payment_plans_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "treatment_plans"
  ADD CONSTRAINT "treatment_plans_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "treatment_plan_items"
  ADD CONSTRAINT "treatment_plan_items_price_nonneg" CHECK ("price" >= 0);

ALTER TABLE "dental_catalog_items"
  ADD CONSTRAINT "dental_catalog_items_default_price_nonneg" CHECK ("defaultPrice" >= 0);

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_valid_range" CHECK ("end" > "start");

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_minstock_nonneg" CHECK ("minStock" >= 0);

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_qty" CHECK (
    ("type" IN ('IN', 'OUT') AND "quantity" > 0)
    OR ("type" = 'ADJUSTMENT' AND "quantity" <> 0)
  );

-- ---------------------------------------------------------------------------
-- 3. DB-011: insumo unico por SEDE y sin distinguir mayusculas (solo vivos).
--    Se crea el nuevo antes de retirar el viejo: la tabla nunca queda sin unico
--    (y el nuevo es estrictamente mas laxo entre sedes y mas estricto dentro de
--    una; el pre-flight ya garantizo que no hay duplicados).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "inventory_items_tenant_location_name_key"
  ON "inventory_items" ("tenantId", "locationId", lower("name"))
  WHERE "deletedAt" IS NULL;
DROP INDEX "inventory_items_tenantId_name_key";

-- ---------------------------------------------------------------------------
-- 4. DB-013: un registro de odontograma por item de plan (respaldo del espejo).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "tooth_records_source_plan_item_key"
  ON "tooth_records" ("tenantId", "sourcePlanItemId")
  WHERE "sourcePlanItemId" IS NOT NULL AND "deletedAt" IS NULL;
