-- OWNER y ADMIN eran idénticos en permisos (los 8 role-sets) y la única ruta
-- exclusiva de OWNER (/domains) pasa a ADMIN -> se elimina el rol. Las
-- membresías OWNER existentes se convierten a ADMIN.
UPDATE "clinic_memberships" SET "role" = 'ADMIN' WHERE "role" = 'OWNER';

-- Postgres no permite borrar un valor de un enum: hay que crear el tipo nuevo
-- y castear la columna (el UPDATE de arriba garantiza que no queda ningún
-- 'OWNER' que el cast no pueda mapear).
ALTER TYPE "ClinicRole" RENAME TO "ClinicRole_old";
CREATE TYPE "ClinicRole" AS ENUM ('DENTIST', 'ASSISTANT', 'RECEPTION', 'ADMIN');
ALTER TABLE "clinic_memberships"
  ALTER COLUMN "role" TYPE "ClinicRole" USING ("role"::text::"ClinicRole");
DROP TYPE "ClinicRole_old";
