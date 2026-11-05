-- DX-224: «¿Quién llama?». Buscar al paciente por el número completo.
--
-- Por qué una columna: la lectura del número (libphonenumber con el prefijo
-- por defecto de la SEDE, DX-329) solo existe en la aplicación; la búsqueda
-- compara el E.164 COMPLETO con `=` (columna comparada con `texteq`, que sí
-- es condición de índice bajo RLS, como "phoneTail" en DX-225). Nunca un
-- sufijo: "phoneTail" (últimos 8 dígitos) sigue siendo solo de la baja «BAJA».
--
-- Cambios (solo esquema; índices y relleno van aparte, DB-029):
--   patients."phoneE164"                         E.164 con «+» de patients."phone"
--   patient_responsible_parties."phoneE164"      ídem del contacto responsable
--   dx_phone_e164_stale()  trigger BEFORE UPDATE OF "phone": si el teléfono
--                          cambia, el E.164 anterior ya no vale y pasa a NULL
--                          (nunca queda el de un número que ya no está). La
--                          aplicación lo vuelve a escribir DESPUÉS, con una
--                          sentencia que no toca "phone" y por tanto no
--                          dispara el trigger. Cubre también la supresión
--                          parcial (DX-039): sin teléfono, sin E.164.
--
-- Bloqueo: ADD COLUMN sin DEFAULT no reescribe la tabla; CREATE TRIGGER toma
-- SHARE ROW EXCLUSIVE un instante (lock_timeout evita encolarse).
--
-- Aditivo y compatible hacia atrás: el código anterior no lee ni escribe la
-- columna. Las filas existentes quedan NULL hasta `npm run phones:e164-backfill`.
-- Es dato personal derivado del teléfono: misma tabla, misma RLS, no se
-- registra en logs.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients" ADD COLUMN "phoneE164" TEXT;
ALTER TABLE "patient_responsible_parties" ADD COLUMN "phoneE164" TEXT;

CREATE FUNCTION public."dx_phone_e164_stale"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."phone" IS DISTINCT FROM OLD."phone" THEN
    NEW."phoneE164" := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patients_phone_e164_stale"
  BEFORE UPDATE OF "phone" ON "patients"
  FOR EACH ROW EXECUTE FUNCTION public."dx_phone_e164_stale"();

CREATE TRIGGER "patient_responsible_parties_phone_e164_stale"
  BEFORE UPDATE OF "phone" ON "patient_responsible_parties"
  FOR EACH ROW EXECUTE FUNCTION public."dx_phone_e164_stale"();
