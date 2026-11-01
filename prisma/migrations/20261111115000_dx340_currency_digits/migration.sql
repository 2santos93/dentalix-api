-- DX-340: decimales por moneda en la tabla de referencia "currencies" (global,
-- sin RLS, como hasta ahora). Dos números distintos, y ninguno es el de
-- formato (los dígitos de formato CLDR 47 siguen en
-- prisma/reference/iso4217.ts y cldr-format-digits-zero.json, que la web
-- copia para formatear sin red):
--
--   currencies."minor_units"      SMALLINT NOT NULL DEFAULT 2: minor units de
--                                 ISO 4217 según la List One de SIX
--                                 (publicada 2026-09-17). Dato normativo.
--   currencies."rounding_digits"  SMALLINT NOT NULL DEFAULT 2: decimales a los
--                                 que Dentalix redondea cada LÍNEA (descuento
--                                 en bloque, precio por convenio); el total de
--                                 un documento es la suma de sus líneas.
--
-- Esta migración solo añade las columnas (con el valor por defecto, el de las
-- monedas de 2 decimales) y las CHECK NOT VALID; la siguiente las rellena
-- desde prisma/reference/currency-digits.ts y las valida (DB-029).
--
-- Límite: los importes son Decimal(14,2) (Decimal(12,2) en algunas tablas),
-- así que ninguna moneda puede tener más de 2 decimales: las de 3 de ISO
-- (BHD, IQD, JOD, KWD, LYD, OMR, TND) no están en el catálogo y la FK las
-- rechaza; la CHECK lo deja explícito. "rounding_digits" nunca supera
-- "minor_units" (no se redondea a más precisión que la de la moneda).
--
-- Sin índice: la tabla tiene ~150 filas y se lee entera (GET /currencies).
-- Ningún importe guardado se lee ni se reescribe.
--
-- Compatible hacia atrás: el código anterior no lee las columnas y sus INSERT
-- (seed, tests) toman los valores por defecto.
-- Rollback: ALTER TABLE "currencies" DROP COLUMN "rounding_digits",
-- DROP COLUMN "minor_units"; (las CHECK caen con ellas) y borrar las dos filas
-- de _prisma_migrations de DX-340.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "currencies"
  ADD COLUMN "minor_units" SMALLINT NOT NULL DEFAULT 2,
  ADD COLUMN "rounding_digits" SMALLINT NOT NULL DEFAULT 2;

ALTER TABLE "currencies"
  ADD CONSTRAINT "currencies_minor_units_check"
  CHECK ("minor_units" BETWEEN 0 AND 2) NOT VALID;

ALTER TABLE "currencies"
  ADD CONSTRAINT "currencies_rounding_digits_check"
  CHECK ("rounding_digits" BETWEEN 0 AND "minor_units") NOT VALID;
