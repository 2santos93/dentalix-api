-- SEC-050 / DB-052: el trigger `cancellation_fees_append_only` cubría UPDATE y
-- DELETE, pero no TRUNCATE: con un TRUNCATE concedido de más (el `GRANT … ON
-- ALL TABLES` repetido de `docker/prod/create-app-role.sql`, o los
-- privilegios por defecto), la app vaciaba la tabla y se perdía la prueba de
-- lo cobrado o condonado. Como `cancellation_policy_versions_no_truncate`
-- (DX-279): trigger BEFORE TRUNCATE, salvo un superusuario (limpieza de las
-- bases de test). La función se reemplaza para que el camino TRUNCATE no lea
-- OLD (no existe en un trigger por sentencia).
--
-- Aditiva: solo catálogo (la función) y un trigger nuevo; CREATE TRIGGER toma
-- SHARE ROW EXCLUSIVE en `cancellation_fees` un instante (tabla pequeña).

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public."cancellation_fees_append_only"() RETURNS trigger
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
    RAISE EXCEPTION 'cancellation_fees es la prueba de lo cobrado o condonado: no se borra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'el cargo ya está anulado: su anulación no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."voidedAt" IS NULL
     OR (pg_catalog.to_jsonb(NEW) - ARRAY['voidedAt', 'voidedById', 'voidReason'])
        IS DISTINCT FROM
        (pg_catalog.to_jsonb(OLD) - ARRAY['voidedAt', 'voidedById', 'voidReason']) THEN
    RAISE EXCEPTION 'un cargo por cancelación solo se actualiza para anularlo'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "cancellation_fees_no_truncate"
  BEFORE TRUNCATE ON "cancellation_fees"
  FOR EACH STATEMENT EXECUTE FUNCTION public."cancellation_fees_append_only"();
