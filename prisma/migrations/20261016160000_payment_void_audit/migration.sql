-- SEC-013: rastro de la anulación de un abono. Hasta ahora DELETE /payments/:id
-- solo ponía `deletedAt`: no quedaba quién lo anuló ni por qué. Se guardan:
--   * "voidedById": usuario que anuló (del token, nunca del cliente). Puntero
--     suave a "users", igual que "createdById" (sin FK: el usuario es global y
--     su nombre se resuelve a través de la membresía, que tiene RLS).
--   * "voidedAt": instante de la anulación (el mismo que "deletedAt").
--   * "voidReason": motivo obligatorio (3–300 caracteres, validado en la API).
--
-- Aditiva y compatible hacia atrás: tres columnas NULLABLE sin DEFAULT (cambio
-- solo de catálogo en Postgres 11+, sin reescribir la tabla). El código
-- desplegado antes de esta migración las ignora; las políticas RLS de
-- "payments" (por "tenantId") cubren las columnas nuevas sin cambios.
--
-- Backfill sin pérdida de datos: los abonos ya anulados conservan su fecha de
-- anulación en "voidedAt"; su autor y motivo quedan NULL (no se conocían).
--
-- Sin índice nuevo: ninguna consulta filtra ni ordena por estas columnas (se
-- leen junto al abono, por su id o por paciente, con los índices existentes).
ALTER TABLE "payments" ADD COLUMN "voidedById" UUID;
ALTER TABLE "payments" ADD COLUMN "voidedAt" TIMESTAMP(3);
ALTER TABLE "payments" ADD COLUMN "voidReason" TEXT;

UPDATE "payments" SET "voidedAt" = "deletedAt" WHERE "deletedAt" IS NOT NULL;
