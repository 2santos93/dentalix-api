-- DX-224 (ronda 2): marca «ya se intentó leer este teléfono».
--
-- Por qué: el barrido horario de `phoneE164` volvía a leer cada hora los
-- teléfonos que ninguna región entiende («llamar a mamá», dos lecturas
-- válidas…). `phoneE164CheckedAt` los marca cuando el relleno los evalúa y no
-- salió un E.164; el barrido solo mira filas SIN marca. Cambiar `phone` quita
-- la marca (el trigger dx_phone_e164_stale, ahora también de la marca): un
-- teléfono nuevo se lee otra vez. Solo la escribe el relleno, nunca un
-- escritor en vivo (que lee con la sede donde se escribe y puede equivocarse
-- de región respecto a la principal).
--
-- Aditivo: ADD COLUMN sin DEFAULT no reescribe la tabla; CREATE OR REPLACE
-- FUNCTION cambia solo el cuerpo (mismos nombre, search_path y trigger).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients" ADD COLUMN "phoneE164CheckedAt" TIMESTAMPTZ(3);
ALTER TABLE "patient_responsible_parties" ADD COLUMN "phoneE164CheckedAt" TIMESTAMPTZ(3);

CREATE OR REPLACE FUNCTION public."dx_phone_e164_stale"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."phone" IS DISTINCT FROM OLD."phone" THEN
    NEW."phoneE164" := NULL;
    NEW."phoneE164CheckedAt" := NULL;
  END IF;
  RETURN NEW;
END;
$$;
