-- DX-271 (auditoría BE-038, BE-039).
--
-- 1) Un paso del día de la cita (llegó, en sillón, listo, completada,
--    confirmada…) que reactiva su vínculo NO falla si el ítem ya está
--    reservado en otra cita viva: la reserva se queda donde está y este
--    vínculo sigue inactivo. Reactivar (desde cancelada, no-show, completada o
--    retirada) y reagendar (cambia `start`) siguen chocando con
--    `appointment_plan_items_active_key`, igual que el alta explícita.
-- 2) La BD no deja retirar (`deletedAt`) el vínculo de una cita COMPLETED:
--    es lo que se hizo en esa visita y fija el mínimo de la siguiente.
--    ERRCODE propio 'DX271', que el filtro de errores traduce a 409.
--
-- Sin SECURITY DEFINER (como el resto de dx256): las funciones corren con el
-- rol que escribe, bajo su RLS. No cambia ninguna política ni el FORCE.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.dx256_sync_reservations() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 item uuid;
 violated text;
BEGIN
 IF NEW.start IS DISTINCT FROM OLD.start
    OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt"
    OR OLD.status IN ('CANCELLED','NO_SHOW','COMPLETED') THEN
  -- Reagendar o reactivar: estricto. Si otra cita viva tiene el ítem, el
  -- índice único lo rechaza (409 en la API).
  UPDATE public.appointment_plan_items SET active=false
   WHERE "tenantId"=NEW."tenantId" AND "appointmentId"=NEW.id;
 ELSE
  -- Cambio de estado del día: cada vínculo en su subtransacción. Si choca
  -- con la reserva de otra cita viva (también una que se confirma a la vez),
  -- se deja como estaba: inactivo, porque el índice no admite dos activos.
  FOR item IN SELECT "planItemId" FROM public.appointment_plan_items
   WHERE "tenantId"=NEW."tenantId" AND "appointmentId"=NEW.id
   ORDER BY "planItemId"
  LOOP
   BEGIN
    UPDATE public.appointment_plan_items SET active=false
     WHERE "tenantId"=NEW."tenantId" AND "appointmentId"=NEW.id AND "planItemId"=item;
   EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS violated = CONSTRAINT_NAME;
    IF violated IS DISTINCT FROM 'appointment_plan_items_active_key' THEN
     RAISE;
    END IF;
   END;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.dx271_completed_link_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL AND EXISTS (
   SELECT 1 FROM public.appointments a
    WHERE a.id=OLD."appointmentId" AND a."tenantId"=OLD."tenantId"
      AND a.status='COMPLETED') THEN
  RAISE EXCEPTION 'Esta cita ya pasó: sus tratamientos no se cambian.'
   USING ERRCODE='DX271';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dx271_completed_link_guard BEFORE UPDATE ON public.appointment_plan_items
 FOR EACH ROW EXECUTE FUNCTION public.dx271_completed_link_guard();

COMMIT;
