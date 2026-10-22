BEGIN;
ALTER TABLE public.appointment_plan_items ADD COLUMN "deletedAt" timestamp(3);
CREATE OR REPLACE FUNCTION public.dx256_link_reservation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
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
