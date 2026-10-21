-- DX-236: referencia global de solo lectura y texto clínico inmutable.
-- Backfill EXCEPCIONAL, una sola vez: el owner desactiva únicamente el trigger
-- de UPDATE y FORCE de diagnoses, copia la etiqueta actual por FK y restaura
-- ambos en la MISMA transacción. ACCESS EXCLUSIVE bloquea escrituras durante
-- toda la ventana; un fallo revierte columna, datos y protecciones. Así el
-- owner NOSUPERUSER NOBYPASSRLS ve TODAS las clínicas sin política adicional.
-- No existe una puerta de bypass permanente ni se cambia la función inmutable.
-- Las etiquetas previas son las disponibles al migrar, no una reconstrucción
-- de etiquetas históricas que antes no se guardaban.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  reference_table text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'dentalix_app') THEN
    FOREACH reference_table IN ARRAY ARRAY['icd10_codes', 'currencies', 'countries', 'cities'] LOOP
      BEGIN
        EXECUTE pg_catalog.format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM dentalix_app', reference_table);
        IF pg_catalog.has_table_privilege('dentalix_app', 'public.' || reference_table, 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
          RAISE WARNING 'DX-236: dentalix_app conserva escritura efectiva en %; un admin debe revisar grants heredados o de otros grantors antes de arrancar la API (db:check-force)', reference_table;
        END IF;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE WARNING 'DX-236: % no puede revocar escritura de dentalix_app en %; un admin debe aplicar REVOKE INSERT, UPDATE, DELETE, TRUNCATE antes de arrancar la API (db:check-force)', current_user, reference_table;
      END;
    END LOOP;
  ELSE
    RAISE WARNING 'DX-236: dentalix_app no existe; create-app-role.sql debe conservar las referencias como solo lectura';
  END IF;
END;
$$;

LOCK TABLE public.clinical_entry_diagnoses IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.clinical_entry_diagnoses ADD COLUMN "labelEs" TEXT;
ALTER TABLE public.clinical_entry_diagnoses NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_entry_diagnoses DISABLE TRIGGER clinical_entry_diagnoses_immutable;
UPDATE public.clinical_entry_diagnoses d
   SET "labelEs" = c.label_es
  FROM public.icd10_codes c
 WHERE c.code = d."icd10Code";
ALTER TABLE public.clinical_entry_diagnoses ENABLE TRIGGER clinical_entry_diagnoses_immutable;
ALTER TABLE public.clinical_entry_diagnoses FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_entry_diagnoses ALTER COLUMN "labelEs" SET NOT NULL;

-- SECURITY INVOKER: basta SELECT sobre la referencia global. No se confía en
-- el texto que mande la app; siempre se copia el que corresponde al código.
CREATE FUNCTION public.dx_clinical_entry_diagnosis_snapshot() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  SELECT c.label_es INTO STRICT NEW."labelEs"
    FROM public.icd10_codes c WHERE c.code = NEW."icd10Code";
  RETURN NEW;
END;
$$;
CREATE TRIGGER clinical_entry_diagnoses_snapshot
  BEFORE INSERT ON public.clinical_entry_diagnoses
  FOR EACH ROW EXECUTE FUNCTION public.dx_clinical_entry_diagnosis_snapshot();
COMMIT;
