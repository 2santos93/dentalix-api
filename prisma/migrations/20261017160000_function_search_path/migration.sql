-- SEC-032 · search_path fijo en las funciones de trigger.
--
-- Problema: con el search_path por defecto, el esquema temporal de la sesión
-- (pg_temp) se busca ANTES que pg_catalog y que public para tablas y tipos, y
-- dentalix_app tiene el privilegio TEMP en la base. Una función de trigger sin
-- search_path fijo resuelve sus nombres sin calificar con el search_path de
-- quien dispara el trigger, así que el rol de la app podía crear una tabla
-- temporal con el nombre de un catálogo o de una tabla de la app y desactivar
-- la protección:
--   - `pg_temp.pg_roles` que lo declara superusuario: DELETE de autorizaciones
--     Ley 1581 (data_processing_consents), de versiones de la política de
--     privacidad y, si el privilegio se filtrara, de audit_events.
--   - `pg_temp.perio_exams` vacía: medidas de un periodontograma FINAL.
--   - `pg_temp.prescriptions` con la receta "recién emitida": medicamentos
--     nuevos en una receta ya emitida o anulada.
--   - `pg_temp.treatment_plan_acceptances` vacía: ítems, moneda y estado de un
--     plan aceptado con firma.
-- Es el mismo defecto que la revisión de DX-038 corrigió en
-- dx_forbid_clinical_record_mutation (inventario completo en el informe
-- SEC-032).
--
-- Corrección, sin cambiar el comportamiento:
--   - `SET search_path = pg_catalog, pg_temp` en TODAS las funciones de
--     trigger que no lo tenían (pg_temp al final: nunca gana a pg_catalog).
--   - Las que leen una tabla se recrean con CREATE OR REPLACE y el nombre
--     calificado (pg_catalog.pg_roles, public."…"). El cuerpo es idéntico salvo
--     la calificación. CREATE OR REPLACE conserva el OID, así que los
--     triggers existentes (también los clonados en cada partición de
--     audit_events) siguen apuntando a la función.
--   - Las que solo miran OLD/NEW y current_setting se fijan con ALTER FUNCTION
--     (también fija los nombres de tipo como text[], uuid o xid, que pg_temp
--     podía suplantar).
--
-- Aditiva e idempotente: CREATE OR REPLACE y ALTER FUNCTION … SET se pueden
-- repetir. Solo exige ser dueño de las funciones (el rol que migra, sea o no
-- superusuario). No toca tablas, datos ni privilegios ni toma bloqueos de
-- tabla. Las funciones SECURITY DEFINER y las de mantenimiento de
-- audit_events ya fijan search_path (`pg_catalog, pg_temp` o
-- `public, pg_temp`, con pg_catalog implícito delante): no cambian.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Consultan pg_roles para dejar la purga del superusuario
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."dx_forbid_consent_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es append-only: no se permite % (DX-037)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE FUNCTION public."dx_forbid_audit_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es append-only: no se permite % (DX-009)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Consultan tablas de la app
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."perio_measures_final_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('app.current_tenant', true), '') = '' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  -- Se mira el examen de ORIGEN (OLD, en UPDATE/DELETE) y el de DESTINO
  -- (NEW, en INSERT/UPDATE): un UPDATE que cambie `examId` no puede sacar una
  -- medida de un examen FINAL ni meterla en uno.
  IF EXISTS (
    SELECT 1 FROM public."perio_exams" e
    WHERE e."status" = 'FINAL'
      AND (
        (TG_OP IN ('UPDATE', 'DELETE') AND e."id" = OLD."examId")
        OR (TG_OP IN ('INSERT', 'UPDATE') AND e."id" = NEW."examId")
      )
  ) THEN
    RAISE EXCEPTION 'perio: las medidas de un examen finalizado no se modifican'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public."prescription_items_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'prescription_items es inmutable: los medicamentos de una receta emitida no se modifican'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
      RAISE EXCEPTION 'prescription_items es inmutable: los medicamentos de una receta emitida no se borran'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."prescriptions" p
     WHERE p."id" = NEW."prescriptionId"
       AND p."tenantId" = NEW."tenantId"
       AND p."status" = 'ISSUED'
       AND p."xmin" = pg_current_xact_id()::xid
  ) THEN
    RAISE EXCEPTION 'prescription_items es inmutable: no se añaden medicamentos a una receta ya emitida'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public."treatment_plan_items_locked_when_accepted"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  plan_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."planId" ELSE NEW."planId" END;
BEGIN
  PERFORM 1 FROM public."treatment_plans" WHERE "id" = plan_id FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM public."treatment_plan_acceptances" WHERE "planId" = plan_id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'el plan está aceptado y firmado: no admite ítems nuevos'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
      RAISE EXCEPTION 'el plan está aceptado y firmado: sus ítems no se borran'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."planId" IS DISTINCT FROM OLD."planId"
     OR NEW."toothNumber" IS DISTINCT FROM OLD."toothNumber"
     OR NEW."surfaces" IS DISTINCT FROM OLD."surfaces"
     OR NEW."catalogItemId" IS DISTINCT FROM OLD."catalogItemId"
     OR NEW."price" IS DISTINCT FROM OLD."price"
     OR NEW."discount" IS DISTINCT FROM OLD."discount"
     OR NEW."notes" IS DISTINCT FROM OLD."notes"
     OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt"
     OR (NEW."status" = 'PROPOSED' AND OLD."status" <> 'PROPOSED') THEN
    RAISE EXCEPTION 'el plan está aceptado y firmado: sus ítems no se modifican'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Versión vigente de DX-040 (20261017090100_treatment_plan_alternatives).
CREATE OR REPLACE FUNCTION public."treatment_plans_locked_when_accepted"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW."currency" IS DISTINCT FROM OLD."currency"
      OR (NEW."status" IN ('DRAFT', 'PRESENTED', 'REJECTED') AND NEW."status" IS DISTINCT FROM OLD."status")
      OR NEW."patientId" IS DISTINCT FROM OLD."patientId")
     AND EXISTS (SELECT 1 FROM public."treatment_plan_acceptances" WHERE "planId" = OLD."id") THEN
    RAISE EXCEPTION 'el plan está aceptado y firmado: su moneda no cambia ni vuelve a borrador, a presentado ni a rechazado'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Solo miran OLD/NEW y current_setting: basta fijar el search_path
-- ---------------------------------------------------------------------------
ALTER FUNCTION public."patient_consents_immutable"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public."perio_exams_final_immutable"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public."prescriptions_immutable"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public."treatment_plan_acceptances_immutable"() SET search_path = pg_catalog, pg_temp;
