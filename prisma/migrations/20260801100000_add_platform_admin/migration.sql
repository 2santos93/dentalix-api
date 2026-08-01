-- Superadmin de plataforma: puede entrar a CUALQUIER clínica. Es un atributo
-- del usuario, no un ClinicRole, porque los roles son por-tenant
-- (ClinicMembership) y esto es justamente lo contrario: transversal.
ALTER TABLE "users" ADD COLUMN "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Se otorga SOLO por migración: no existe (ni debe existir) endpoint que lo
-- conceda. Idempotente: si el usuario no existe, no hace nada.
UPDATE "users" SET "isPlatformAdmin" = true WHERE "email" = 'nelsoncaicedod1@gmail.com';
