-- DX-051 (revisión de la tarea 1):
--
-- 1. dx_release_item_allocations bloquea las imputaciones del ítem ANTES de
--    calcular lo que sobra. Antes sumaba primero y bloqueaba después: si una
--    anulación (R12) o una reasignación (R10) borraba una imputación del ítem
--    entre la suma y el bloqueo, el bucle seguía recortando por un sobrante
--    que ya no existía y podía rebajar un abono fijado a mano (MANUAL 70 -> 40)
--    que el reparto automático nunca repone. Ahora: FOR UPDATE de las filas
--    del ítem en orden de id (los otros que las bloquean son borradores por
--    abono, con una fila como mucho de este ítem: sin ciclo), la suma en una
--    sentencia POSTERIOR (ve el borrado confirmado) y el bucle de siempre (el
--    re-bloqueo es un no-op).
-- 2. payment_allocation_movements solo lo escribe el trigger
--    payment_allocations_movements: un INSERT directo de la app (que tiene
--    GRANT INSERT para que el trigger, que corre con su rol, pueda escribir)
--    falla. Se reconoce al trigger por la profundidad (pg_trigger_depth() > 1:
--    el INSERT viene de dentro de otro trigger). El superusuario (limpieza y
--    siembra de tests) no se ve afectado.
--
-- Compatible hacia atrás: reemplaza una función y añade un trigger a una tabla
-- que solo escribe el código de este ticket.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.dx_release_item_allocations(p_tenant uuid, p_item uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_cause text := pg_catalog.current_setting('app.allocation_cause', true);
  v_excess numeric;
  r record;
BEGIN
  PERFORM public.dx051_require_tenant(p_tenant);
  -- 1. Bloqueo de las filas candidatas, en orden determinista.
  PERFORM 1 FROM public."payment_allocations" a
   WHERE a."tenantId" = p_tenant AND a."treatmentPlanItemId" = p_item
   ORDER BY a."id"
     FOR UPDATE;
  -- 2. Sobrante en una sentencia posterior: solo cuenta filas vivas y bloqueadas.
  SELECT coalesce(sum(a."amount"), 0) - public.dx051_item_billable(p_tenant, p_item)
    INTO v_excess
    FROM public."payment_allocations" a
   WHERE a."tenantId" = p_tenant AND a."treatmentPlanItemId" = p_item;
  IF v_excess <= 0 THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.set_config('app.allocation_cause', 'RELEASE', true);
  FOR r IN
    SELECT a."id", a."amount"
      FROM public."payment_allocations" a
      JOIN public."payments" p
        ON p."tenantId" = a."tenantId" AND p."id" = a."paymentId"
     WHERE a."tenantId" = p_tenant AND a."treatmentPlanItemId" = p_item
     ORDER BY CASE a."source" WHEN 'AUTO' THEN 0 ELSE 1 END,
              p."paidAt" DESC, p."createdAt" DESC, a."id" DESC
       FOR UPDATE OF a
  LOOP
    EXIT WHEN v_excess <= 0;
    IF r."amount" <= v_excess THEN
      DELETE FROM public."payment_allocations" WHERE "id" = r."id";
      v_excess := v_excess - r."amount";
    ELSE
      UPDATE public."payment_allocations"
         SET "amount" = "amount" - v_excess
       WHERE "id" = r."id";
      v_excess := 0;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('app.allocation_cause', coalesce(v_prev_cause, ''), true);
END;
$$;

CREATE FUNCTION public.payment_allocation_movements_only_from_trigger() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_catalog.pg_trigger_depth() > 1 OR public.dx_cash_is_superuser() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payment_allocation_movements lo escribe solo el trigger de payment_allocations (DX-051)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "payment_allocation_movements_only_from_trigger"
  BEFORE INSERT ON "payment_allocation_movements"
  FOR EACH ROW EXECUTE FUNCTION public.payment_allocation_movements_only_from_trigger();
