-- DX-374 (revisión): "createdAt" de `manual_exchange_rates` con la hora del
-- servidor en UTC por trigger (DX-226), como `location_holidays`
-- (20261028170200_dx316_location_calendar_tables). El DEFAULT ya era UTC, pero
-- un INSERT que nombra "createdAt" (el reloj de la API) lo saltaba: el
-- trigger lo pisa siempre.
--
-- Solo el INSERT: la app no tiene UPDATE en la tabla. Función propia con
-- search_path fijo (SEC-032).
--
-- Compatible hacia atrás: no cambia columnas ni datos. lock_timeout 5 s:
-- CREATE TRIGGER toma SHARE ROW EXCLUSIVE sobre la tabla un instante.

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.dx_manual_exchange_rate_server_created_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "manual_exchange_rates_server_created_at"
  BEFORE INSERT ON "manual_exchange_rates"
  FOR EACH ROW EXECUTE FUNCTION public.dx_manual_exchange_rate_server_created_at();
