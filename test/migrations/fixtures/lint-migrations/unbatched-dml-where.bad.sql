-- Con WHERE pero en una sola sentencia, junto a DDL de la tabla.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "payments" ADD COLUMN "civilDay" DATE;
UPDATE "payments" SET "civilDay" = "paidAt"::date WHERE "civilDay" IS NULL;
