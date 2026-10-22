-- DX-256 / DX-226: timestamp columns store UTC even when an administrator
-- changes the session TimeZone. Keep the existing tenant FK error contract.
-- No price, acceptance snapshot/hash, item metadata or RLS policy is rewritten.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE public.appointment_plan_items ALTER COLUMN "createdAt"
 SET DEFAULT timezone('UTC', now());
CREATE OR REPLACE FUNCTION public.dx256_item_patient() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW."patientId" IS NULL THEN
  SELECT p."patientId" INTO NEW."patientId" FROM public.treatment_plans p
   WHERE p.id=NEW."planId" AND p."tenantId"=NEW."tenantId";
  IF NOT FOUND THEN
   -- Preserve the existing FK failure contract even when RLS hides the plan.
   RAISE EXCEPTION 'El plan de tratamiento no existe en esta clínica.'
    USING ERRCODE='foreign_key_violation', CONSTRAINT='treatment_plan_items_plan_patient_fkey';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.dx256_visits_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE plan_status text;
BEGIN
 IF TG_TABLE_NAME='treatment_plans' THEN
  IF NEW."visitIntervals" IS DISTINCT FROM OLD."visitIntervals" AND OLD.status NOT IN ('DRAFT','PRESENTED','ACCEPTED') THEN RAISE EXCEPTION 'El plan está cerrado: no se pueden cambiar sus visitas.' USING ERRCODE='restrict_violation'; END IF;
  IF NEW.status='ACCEPTED' AND OLD.status<>'ACCEPTED' AND NEW."acceptedAt" IS NULL THEN
   NEW."acceptedAt":=timezone('UTC', now());
   NEW."acceptedLocationId":=coalesce(NEW."acceptedLocationId",NEW."presentedLocationId",(SELECT l.id FROM public.locations l WHERE l."tenantId"=NEW."tenantId" AND l."deletedAt" IS NULL ORDER BY l."createdAt",l.id LIMIT 1));
  END IF;
 ELSE
  IF NEW.visit IS DISTINCT FROM OLD.visit OR NEW."visitLabel" IS DISTINCT FROM OLD."visitLabel" THEN
   SELECT p.status INTO plan_status FROM public.treatment_plans p WHERE p.id=NEW."planId" FOR SHARE;
   IF plan_status NOT IN ('DRAFT','PRESENTED','ACCEPTED') THEN RAISE EXCEPTION 'El plan está cerrado: no se pueden cambiar sus visitas.' USING ERRCODE='restrict_violation'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
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
  AND (a.start>=timezone('UTC', now()) OR a.status IN ('ARRIVED','IN_CHAIR','READY_FOR_CHECKOUT')) INTO NEW.active
 FROM public.appointments a WHERE a.id=NEW."appointmentId" AND a."tenantId"=NEW."tenantId" AND a."patientId"=NEW."patientId";
 NEW.active:=coalesce(NEW.active,false);
 IF NEW.active THEN
  -- Se libera por el estado REAL de la cita, también si el reloj hizo vencer
  -- la reserva sin que nadie actualizara su fila. El índice único arbitra las
  -- dos transacciones concurrentes tras esta limpieza.
  UPDATE public.appointment_plan_items link SET active=false FROM public.appointments a
   WHERE link."tenantId"=NEW."tenantId" AND link."planItemId"=NEW."planItemId" AND link.active
    AND link."appointmentId"<>NEW."appointmentId" AND a.id=link."appointmentId"
    AND (a."deletedAt" IS NOT NULL OR a.status IN ('CANCELLED','COMPLETED','NO_SHOW') OR (a.start<timezone('UTC', now()) AND a.status IN ('SCHEDULED','CONFIRMED')));
 END IF;
 RETURN NEW;
END $$;
COMMIT;
