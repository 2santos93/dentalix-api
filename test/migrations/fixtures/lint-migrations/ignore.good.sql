-- Excepción explícita, con motivo, en el propio fichero.
-- lint-migrations: ignore unbatched-dml: catálogo de 40 filas, sin tráfico de la app
SET LOCAL lock_timeout = '5s';
ALTER TABLE "anesthetic_products" ADD COLUMN "minAgeYears" INTEGER;
UPDATE "anesthetic_products" SET "minAgeYears" = 12 WHERE "minAgeYears" IS NULL;
