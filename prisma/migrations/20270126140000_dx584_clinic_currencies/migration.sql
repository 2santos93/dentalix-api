-- DX-584: monedas de la clínica y tasa visible en el menú.
--
-- Cambios, todos ADITIVOS (el código anterior no lee ni escribe nada nuevo):
--   tenants."acceptedCurrencies"     CHAR(3)[] NOT NULL DEFAULT '{}': monedas
--                                    en que la clínica acepta cobros (ISO 4217,
--                                    en el orden del ADMIN). '{}' = cualquiera,
--                                    lo de antes: SIN relleno, ninguna clínica
--                                    cambia de comportamiento hasta que el
--                                    ADMIN lo configure. En PG 16, ADD COLUMN
--                                    con DEFAULT constante y NOT NULL solo
--                                    toca el catálogo. CHECK NOT VALID: 0..8
--                                    elementos, sin NULL, tres mayúsculas y
--                                    sin repetidas (dx_currency_list_ok). Que
--                                    cada código esté en `currencies` lo
--                                    valida la API (un array no lleva FK).
--   tenants."rateReferenceCurrency"  CHAR(3) NULL: moneda contra la que el menú
--                                    muestra las equivalencias. NULL = la de la
--                                    sede activa. FK a currencies NOT VALID.
--   tenants."showRateInHeader"       BOOLEAN NULL: NULL = automático; true/false
--                                    = forzado por el ADMIN.
--   dx_currency_list_ok(bpchar[])    IMMUTABLE, search_path fijo (SEC-032): la
--                                    regla del CHECK.
--
-- `tenants` y `currencies` no tienen RLS (patrón DX-316); las columnas heredan
-- el grant de la tabla a dentalix_app. Sin columnas ni tablas hacia patients:
-- dx_patient_merge_tables() (DX-266) no cambia. Sin eventos de auditoría sin
-- usuario: audit_events_actor_check no cambia.
--
-- Los VALIDATE van en 20270126140100 (otra transacción).
--
-- Vuelta atrás (sin pérdida de importes ni de abonos): desplegar la API
-- anterior y
--   ALTER TABLE "tenants" DROP COLUMN "acceptedCurrencies",
--     DROP COLUMN "rateReferenceCurrency", DROP COLUMN "showRateInHeader";
--   DROP FUNCTION public.dx_currency_list_ok(bpchar[]);

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.dx_currency_list_ok(codes bpchar[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT codes IS NOT NULL
    AND coalesce(cardinality(codes), 0) <= 8
    AND array_position(codes, NULL) IS NULL
    AND (SELECT bool_and(c::text ~ '^[A-Z]{3}$') IS NOT FALSE FROM unnest(codes) AS c)
    AND (SELECT count(DISTINCT c) FROM unnest(codes) AS c) = coalesce(cardinality(codes), 0)
$$;

ALTER TABLE "tenants"
  ADD COLUMN "acceptedCurrencies" CHAR(3)[] NOT NULL DEFAULT ARRAY[]::CHAR(3)[],
  ADD COLUMN "rateReferenceCurrency" CHAR(3),
  ADD COLUMN "showRateInHeader" BOOLEAN;

ALTER TABLE "tenants" ADD CONSTRAINT "tenants_accepted_currencies_check"
  CHECK (public.dx_currency_list_ok("acceptedCurrencies")) NOT VALID;

ALTER TABLE "tenants" ADD CONSTRAINT "tenants_rate_reference_currency_fkey"
  FOREIGN KEY ("rateReferenceCurrency") REFERENCES "currencies"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
