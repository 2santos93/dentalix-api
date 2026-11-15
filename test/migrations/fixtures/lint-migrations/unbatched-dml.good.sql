-- Solo esquema: el relleno va por lotes fuera de la migración. El UPDATE de
-- una tabla creada aquí mismo no cuenta (no tiene filas de nadie).
SET LOCAL lock_timeout = '5s';
CREATE TABLE "nickname_rules" ("id" UUID PRIMARY KEY, "rule" TEXT);
UPDATE "nickname_rules" SET "rule" = 'x';
ALTER TABLE "patients" ADD COLUMN "nickname" TEXT;
