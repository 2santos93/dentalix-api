-- DX-319: nº de registro sanitario de la sede (paso 1 de 2).
--
-- Cambios:
--   locations."healthRegistrationNumber"      texto libre opcional, sin formato
--                                             por país; 1–64 caracteres sin
--                                             espacios a los lados (la API
--                                             recorta y guarda null si queda
--                                             vacío; esto es la red).
--   locations."showHealthRegistrationNumber"  si el nº sale en los documentos
--                                             de la sede; por defecto false.
--
-- Compatible hacia atrás: solo AÑADE una columna nullable y una con DEFAULT
-- (PG16: sin reescribir la tabla). El código anterior no las conoce. La copia
-- del REPS y el DROP van en 20261024174100_dx319_drop_location_reps.
--
-- Grants: no aplica (columnas de una tabla que dentalix_app ya usa).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "locations" ADD COLUMN "healthRegistrationNumber" TEXT;
ALTER TABLE "locations"
  ADD COLUMN "showHealthRegistrationNumber" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "locations" ADD CONSTRAINT "locations_health_registration_number_check"
  CHECK (
    "healthRegistrationNumber" IS NULL
    OR (
      char_length("healthRegistrationNumber") BETWEEN 1 AND 64
      AND "healthRegistrationNumber" = btrim("healthRegistrationNumber")
    )
  );
