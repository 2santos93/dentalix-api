-- DX-051 (tarea 3): el drenado reclama las solicitudes de un plan con
-- `SELECT … FOR UPDATE SKIP LOCKED` (spec R9.1), y Postgres exige para
-- cualquier FOR UPDATE/SHARE el privilegio UPDATE de al menos una columna.
-- Se concede el de "requestedAt" y un trigger rechaza todo UPDATE: la cola
-- sigue siendo de solo-inserción (spec §3.3), y el privilegio solo sirve
-- para bloquear filas.
--
-- Compatible hacia atrás: añade un privilegio de columna y un trigger a una
-- tabla que solo escribe el código de este ticket.

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.plan_allocation_rebalance_requests_insert_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'plan_allocation_rebalance_requests es una cola de solo-inserción: no admite UPDATE (DX-051)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "plan_allocation_rebalance_requests_insert_only"
  BEFORE UPDATE ON "plan_allocation_rebalance_requests"
  FOR EACH ROW EXECUTE FUNCTION public.plan_allocation_rebalance_requests_insert_only();

GRANT UPDATE ("requestedAt") ON "plan_allocation_rebalance_requests" TO dentalix_app;
