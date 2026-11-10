-- DX-484: valida el CHECK del código, lo hace NOT NULL y cierra el trigger de
-- edición.
--
-- VALIDATE CONSTRAINT recorre patients con SHARE UPDATE EXCLUSIVE: no bloquea
-- lecturas ni escrituras. Un CHECK ve todas las filas aunque el owner esté
-- sujeto a la RLS (README, DX-134), así que no hace falta NO FORCE. Falla de
-- forma ruidosa si el relleno dejó algún 0 o NULL.
--
-- SET NOT NULL toma ACCESS EXCLUSIVE, pero el CHECK ya validado demuestra que
-- no hay nulos y se salta el recorrido: solo catálogo. El CHECK se queda.
--
-- Con todas las filas numeradas, patients_code_immutable ya no necesita la
-- excepción 0 → número del relleno: desde aquí, ningún cambio del código.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_patient_code_check";

ALTER TABLE "patients" ALTER COLUMN "patientCode" SET NOT NULL;

CREATE OR REPLACE FUNCTION public."dx_patients_code_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."patientCode" IS DISTINCT FROM OLD."patientCode" THEN
    RAISE EXCEPTION 'El código del paciente no se puede cambiar (DX-484)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
