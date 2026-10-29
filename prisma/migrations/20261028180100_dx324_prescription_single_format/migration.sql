-- DX-324 (epic DX-311 «Producto global, sin supuestos de país»): receta única.
-- Qué se exige y qué se imprime ya no depende del país de la sede: lo deciden
-- los ajustes de la clínica, que la receta congela en su foto.
--
-- Expand, solo `prescriptions`:
--   - "singleFormat" NOT NULL DEFAULT false: un default constante solo toca el
--     catálogo (attmissingval), sin reescribir la tabla. Toda receta anterior
--     queda en false (legada, hash v1/v2), y una réplica anterior que inserte
--     sin nombrarla recibe false, que es lo que escribe: una receta legada.
--   - "printQuantityInWords", "professionalSpecialty", "patientAgeYears" y
--     "patientWeightKg": NULLABLE sin DEFAULT, NULL en las legadas.
--   - Las columnas nuevas nacen inmutables: el trigger "prescriptions_immutable"
--     compara la fila entera (to_jsonb) y solo deja anular.
--   - "country" sigue NOT NULL en esta fase: la receta única lo sigue
--     escribiendo, como dato, para las réplicas anteriores, cuyo cliente lo
--     lee como no nulo (pre-flight I5). Nada nuevo lo lee para decidir. La
--     fase 2 (ticket aparte) lo deja de escribir.
--
-- CHECK:
--   - "prescriptions_country_fields_check" pasa a
--     "prescriptions_legacy_country_fields_check": la regla de cada país solo
--     vale para las recetas legadas. Una receta única escribe "country" pero
--     no tiene que cumplir sus reglas. Para "singleFormat" = false es la misma
--     condición que antes, así que una réplica anterior no nota el cambio.
--   - "prescriptions_single_format_check": la receta única congela el ajuste
--     de las letras (y solo ella); especialidad de 1 a 80 caracteres; edad de
--     0 a 150; peso mayor que 0 y menor que 400. La API guarda NULL fuera de
--     esos rangos antes de llegar aquí; esto es la red.
--   NOT VALID + VALIDATE en la misma transacción: cada VALIDATE recorre la
--   tabla bajo el ACCESS EXCLUSIVE que ya tomó el ADD COLUMN (no bajo un
--   bloqueo más débil). Es breve porque `prescriptions` es pequeña; en una
--   tabla grande, el VALIDATE iría en una migración posterior. El DROP y el
--   ADD van en la misma transacción: no hay un momento sin regla.
--
-- lock_timeout 5 s: si una transacción larga retiene la tabla, falla limpia y
-- se reintenta el deploy.
--
-- Sin índices: ninguna consulta filtra ni ordena por las columnas nuevas. Sin
-- trigger UTC (DX-226): no hay columnas de fecha. Grants: no aplica.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "prescriptions"
  ADD COLUMN "singleFormat" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "printQuantityInWords" BOOLEAN,
  ADD COLUMN "professionalSpecialty" TEXT,
  ADD COLUMN "patientAgeYears" INTEGER,
  ADD COLUMN "patientWeightKg" DOUBLE PRECISION;

ALTER TABLE "prescriptions"
  DROP CONSTRAINT "prescriptions_country_fields_check";
ALTER TABLE "prescriptions"
  ADD CONSTRAINT "prescriptions_legacy_country_fields_check" CHECK (
    "singleFormat"
    OR ("country" = 'CO' AND "clinicalRecordNumber" IS NOT NULL)
    OR ("country" = 'ES' AND "patientDocument" IS NOT NULL AND "patientBirthYear" IS NOT NULL)
  ) NOT VALID;
ALTER TABLE "prescriptions"
  VALIDATE CONSTRAINT "prescriptions_legacy_country_fields_check";

ALTER TABLE "prescriptions"
  ADD CONSTRAINT "prescriptions_single_format_check" CHECK (
    "singleFormat" = ("printQuantityInWords" IS NOT NULL)
    AND (
      "professionalSpecialty" IS NULL
      OR length(btrim("professionalSpecialty")) BETWEEN 1 AND 80
    )
    AND ("patientAgeYears" IS NULL OR "patientAgeYears" BETWEEN 0 AND 150)
    AND (
      "patientWeightKg" IS NULL
      OR ("patientWeightKg" > 0 AND "patientWeightKg" < 400)
    )
  ) NOT VALID;
ALTER TABLE "prescriptions"
  VALIDATE CONSTRAINT "prescriptions_single_format_check";
