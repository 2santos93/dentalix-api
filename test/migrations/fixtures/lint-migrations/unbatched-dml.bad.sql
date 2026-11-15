-- Backfill de toda la tabla junto al DDL que añade la columna (como DX-039).
SET LOCAL lock_timeout = '5s';
ALTER TABLE "patients" ADD COLUMN "nickname" TEXT;
UPDATE "patients" SET "nickname" = "firstName";
