-- DX-256: organización clínica, separada del snapshot financiero firmado.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE public.locations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.treatment_plans NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.treatment_plan_items NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.appointments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.treatment_plan_acceptances NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.treatment_plan_items ADD COLUMN visit integer NOT NULL DEFAULT 1,
  ADD COLUMN "visitLabel" varchar(60), ADD COLUMN "patientId" uuid;
ALTER TABLE public.treatment_plans ADD COLUMN "visitIntervals" jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN "acceptedAt" timestamp(3), ADD COLUMN "acceptedLocationId" uuid;
-- Los triggers financieros permiten este backfill: no cambia ninguno de sus campos
-- sellados. La sesión de migración no tiene GUC, y la función de cierre lo permite.
UPDATE public.treatment_plan_items i SET "patientId"=p."patientId"
 FROM public.treatment_plans p WHERE i."planId"=p.id AND i."tenantId"=p."tenantId";
ALTER TABLE public.treatment_plan_items ALTER COLUMN "patientId" SET NOT NULL;
ALTER TABLE public.treatment_plan_items ADD CONSTRAINT treatment_plan_items_visit_check CHECK (visit BETWEEN 1 AND 1000);
ALTER TABLE public.treatment_plan_items ADD CONSTRAINT treatment_plan_items_tenant_patient_id_key UNIQUE ("tenantId","patientId",id);
ALTER TABLE public.treatment_plan_items ADD CONSTRAINT treatment_plan_items_plan_patient_fkey
 FOREIGN KEY ("tenantId","planId","patientId") REFERENCES public.treatment_plans("tenantId",id,"patientId") ON DELETE RESTRICT;
-- Legado: firma es la fuente autoritativa. Sin firma no existe timestamp de
-- aceptación persistido; updatedAt es fallback histórico, nunca se vuelve a tocar.
UPDATE public.treatment_plans p SET "acceptedAt"=coalesce(a."acceptedAt",p."updatedAt"),
 "acceptedLocationId"=coalesce(a."locationId",p."presentedLocationId",
 (SELECT l.id FROM public.locations l WHERE l."tenantId"=p."tenantId" AND l."deletedAt" IS NULL ORDER BY l."createdAt",l.id LIMIT 1))
 FROM (SELECT p2.id,a2."acceptedAt",a2."locationId" FROM public.treatment_plans p2 LEFT JOIN public.treatment_plan_acceptances a2 ON a2."planId"=p2.id) a
 WHERE a.id=p.id AND p.status IN ('ACCEPTED','COMPLETED');
CREATE FUNCTION public.dx256_valid_intervals(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE
 SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(value)<>'object' THEN false ELSE NOT EXISTS (
 SELECT 1 FROM jsonb_each(value) e WHERE e.key !~ '^[1-9][0-9]{0,3}$'
 OR length(e.key)>4 OR CASE WHEN e.key ~ '^[1-9][0-9]{0,3}$' THEN e.key::integer>1000 ELSE true END
 OR CASE WHEN jsonb_typeof(e.value)='number' THEN (e.value::text)::numeric NOT BETWEEN 0 AND 3650 OR trunc((e.value::text)::numeric)<>(e.value::text)::numeric ELSE true END) END
 $$;
ALTER TABLE public.treatment_plans ADD CONSTRAINT treatment_plans_visit_intervals_check CHECK(public.dx256_valid_intervals("visitIntervals"));
ALTER TABLE public.treatment_plans ADD CONSTRAINT treatment_plans_accepted_location_fkey FOREIGN KEY ("tenantId","acceptedLocationId") REFERENCES public.locations("tenantId",id) ON DELETE RESTRICT;
CREATE INDEX treatment_plans_unscheduled_idx ON public.treatment_plans("tenantId","acceptedLocationId",id) WHERE status='ACCEPTED' AND "deletedAt" IS NULL;
CREATE INDEX treatment_plan_items_unscheduled_idx ON public.treatment_plan_items("tenantId","planId",visit,id) INCLUDE(price,discount) WHERE status='ACCEPTED' AND "deletedAt" IS NULL;
CREATE FUNCTION public.dx256_item_patient() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW."patientId" IS NULL THEN SELECT p."patientId" INTO NEW."patientId" FROM public.treatment_plans p WHERE p.id=NEW."planId" AND p."tenantId"=NEW."tenantId"; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_dx256_item_patient BEFORE INSERT ON public.treatment_plan_items FOR EACH ROW EXECUTE FUNCTION public.dx256_item_patient();
CREATE FUNCTION public.dx256_visits_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE plan_status text;
BEGIN
 IF TG_TABLE_NAME='treatment_plans' THEN
  IF NEW."visitIntervals" IS DISTINCT FROM OLD."visitIntervals" AND OLD.status NOT IN ('DRAFT','PRESENTED','ACCEPTED') THEN RAISE EXCEPTION 'El plan está cerrado: no se pueden cambiar sus visitas.' USING ERRCODE='restrict_violation'; END IF;
  IF NEW.status='ACCEPTED' AND OLD.status<>'ACCEPTED' AND NEW."acceptedAt" IS NULL THEN
   NEW."acceptedAt":=CURRENT_TIMESTAMP;
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
CREATE TRIGGER dx256_plan_visits_guard BEFORE UPDATE ON public.treatment_plans FOR EACH ROW EXECUTE FUNCTION public.dx256_visits_guard();
CREATE TRIGGER dx256_item_visits_guard BEFORE UPDATE ON public.treatment_plan_items FOR EACH ROW EXECUTE FUNCTION public.dx256_visits_guard();
CREATE TABLE public.appointment_plan_items (
 "tenantId" uuid NOT NULL, "patientId" uuid NOT NULL, "appointmentId" uuid NOT NULL, "planItemId" uuid NOT NULL,
 active boolean NOT NULL DEFAULT false, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY("tenantId","appointmentId","planItemId"),
 CONSTRAINT appointment_plan_items_appointment_fkey FOREIGN KEY ("tenantId","patientId","appointmentId") REFERENCES public.appointments("tenantId","patientId",id) ON DELETE CASCADE,
 CONSTRAINT appointment_plan_items_item_fkey FOREIGN KEY ("tenantId","patientId","planItemId") REFERENCES public.treatment_plan_items("tenantId","patientId",id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX appointment_plan_items_active_key ON public.appointment_plan_items("tenantId","planItemId") WHERE active;
CREATE INDEX appointment_plan_items_item_idx ON public.appointment_plan_items("tenantId","planItemId","appointmentId");
CREATE FUNCTION public.dx256_link_reservation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 SELECT a."deletedAt" IS NULL AND a.status IN ('SCHEDULED','CONFIRMED','ARRIVED','IN_CHAIR','READY_FOR_CHECKOUT')
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
CREATE TRIGGER dx256_link_reservation BEFORE INSERT OR UPDATE ON public.appointment_plan_items FOR EACH ROW EXECUTE FUNCTION public.dx256_link_reservation();
CREATE FUNCTION public.dx256_sync_reservations() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 UPDATE public.appointment_plan_items SET active=false WHERE "tenantId"=NEW."tenantId" AND "appointmentId"=NEW.id;
 RETURN NEW;
END $$;
CREATE TRIGGER dx256_sync_reservations AFTER UPDATE OF start,status,"deletedAt" ON public.appointments FOR EACH ROW EXECUTE FUNCTION public.dx256_sync_reservations();
ALTER TABLE public.appointment_plan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_plan_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.appointment_plan_items USING ("tenantId"=NULLIF(current_setting('app.current_tenant',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.current_tenant',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.appointment_plan_items TO dentalix_app;
ALTER TABLE public.locations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.treatment_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.treatment_plan_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.appointments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.treatment_plan_acceptances FORCE ROW LEVEL SECURITY;
COMMIT;
