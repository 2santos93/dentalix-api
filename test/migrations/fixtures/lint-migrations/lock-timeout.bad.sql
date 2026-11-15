-- DDL sobre una tabla que ya existe, sin lock_timeout antes.
ALTER TABLE "chairs" ADD COLUMN "color" TEXT;
SET LOCAL lock_timeout = '5s';
