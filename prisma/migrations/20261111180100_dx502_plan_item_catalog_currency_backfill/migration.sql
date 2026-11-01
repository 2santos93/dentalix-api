-- DX-502: relleno de "catalogCurrency" en los ítems existentes, por lotes, sin
-- DDL. Molde de 20261030120100_dx327_document_type_backfill.
--
-- Regla (la de `catalogCurrencyOf` en la API y `clinicBaseCurrency` en la
-- web): la moneda común de las sedes ACTIVAS y vivas de la clínica. Si no hay
-- sedes activas, si tienen monedas distintas o si alguna no tiene moneda, no
-- hay moneda del catálogo: la clínica se salta y sus ítems quedan NULL (la web
-- oculta entonces el precio de lista con la nota de referencia). Solo los
-- ítems con precio de catálogo ("basePrice" NOT NULL), también los retirados
-- y los de planes firmados o cerrados: la moneda es la de hoy, la mejor
-- aproximación a la del día del alta. Ningún importe cambia.
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra un lote de 2.000 filas.
-- Ningún lote toma ACCESS EXCLUSIVE: solo los bloqueos de fila de su lote, y
-- solo hasta su COMMIT. Recorrido por cursor (id > último).
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS
-- le aplica, así que recorre las clínicas y fija `app.current_tenant` en cada
-- lote. Los triggers de bloqueo dejan pasar este relleno único (ver
-- 20261111180000_dx502_plan_item_catalog_currency).
--
-- Idempotente: solo toca los ítems aún sin moneda. Si se corta a mitad (los
-- lotes hechos quedan), basta con repetirla (`prisma migrate resolve
-- --rolled-back 20261111180100_dx502_plan_item_catalog_currency_backfill` y
-- `deploy`).
DO $$
DECLARE
  t uuid;
  v_currency text;
  last_id uuid;
  batch uuid[];
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    SELECT CASE
             WHEN pg_catalog.count(*) > 0
              AND pg_catalog.count(*) = pg_catalog.count(l."currency")
              AND pg_catalog.count(DISTINCT l."currency") = 1
             THEN pg_catalog.min(l."currency")
           END
      INTO v_currency
      FROM public."locations" l
     WHERE l."tenantId" = t
       AND l."isActive"
       AND l."deletedAt" IS NULL;
    COMMIT;
    CONTINUE WHEN v_currency IS NULL;

    last_id := NULL;
    LOOP
      PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
      PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
      SELECT pg_catalog.array_agg(s."id") INTO batch
        FROM (SELECT i."id" FROM public."treatment_plan_items" i
               WHERE i."tenantId" = t
                 AND (last_id IS NULL OR i."id" > last_id)
               ORDER BY i."id"
               LIMIT 2000) s;
      EXIT WHEN batch IS NULL;
      last_id := batch[pg_catalog.array_length(batch, 1)];
      UPDATE public."treatment_plan_items" i
         SET "catalogCurrency" = v_currency
       WHERE i."tenantId" = t
         AND i."id" = ANY (batch)
         AND i."basePrice" IS NOT NULL
         AND i."catalogCurrency" IS NULL;
      COMMIT;
    END LOOP;
  END LOOP;
END
$$;
