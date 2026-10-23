BEGIN;
CREATE OR REPLACE FUNCTION public.dx256_link_reservation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 -- INSERT/FK reassignment must observe status after a concurrent reactivation.
 -- Housekeeping UPDATE(active) never locks the parent: appointment sync already
 -- owns it, and locking from an existing child would invert parent -> child.
 IF TG_OP='INSERT' OR NEW."appointmentId" IS DISTINCT FROM OLD."appointmentId"
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."patientId" IS DISTINCT FROM OLD."patientId" THEN
  PERFORM 1 FROM public.appointments a WHERE a.id=NEW."appointmentId"
   AND a."tenantId"=NEW."tenantId" AND a."patientId"=NEW."patientId" FOR SHARE;
 END IF;
 SELECT NEW."deletedAt" IS NULL AND a."deletedAt" IS NULL AND a.status IN ('SCHEDULED','CONFIRMED','ARRIVED','IN_CHAIR','READY_FOR_CHECKOUT')
  AND (a.start>=CURRENT_TIMESTAMP OR a.status IN ('ARRIVED','IN_CHAIR','READY_FOR_CHECKOUT')) INTO NEW.active
 FROM public.appointments a WHERE a.id=NEW."appointmentId" AND a."tenantId"=NEW."tenantId" AND a."patientId"=NEW."patientId";
 NEW.active:=coalesce(NEW.active,false);
 IF NEW.active THEN
  -- Se libera por el estado REAL de la cita, también si el reloj hizo vencer
  -- la reserva sin que nadie actualizara su fila. El índice único arbitra las
  -- dos transacciones concurrentes tras esta limpieza.
  UPDATE public.appointment_plan_items link SET active=false FROM public.appointments a
   WHERE link."tenantId"=NEW."tenantId" AND link."planItemId"=NEW."planItemId" AND link.active
    AND link."appointmentId"<>NEW."appointmentId" AND a.id=link."appointmentId"
    AND (a."deletedAt" IS NOT NULL OR a.status IN ('CANCELLED','COMPLETED','NO_SHOW') OR (a.start<CURRENT_TIMESTAMP AND a.status IN ('SCHEDULED','CONFIRMED')));
 END IF;
 RETURN NEW;
END $$;
COMMIT;
