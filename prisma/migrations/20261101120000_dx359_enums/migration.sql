-- DX-359: auditoría de los accesos del personal y de la cuenta propia.
-- Valores de enum nuevos.
--
-- Cambios:
--   AuditAction         PASSWORD_CHANGE: el titular cambia su contraseña
--                       desde su perfil (POST /me/password). Distinto de
--                       PASSWORD_RESET, que es el enlace por email (DX-010).
--   AuditResourceType   STAFF_INVITATION: invitar, reenviar y retirar una
--                       invitación al personal (ADMIN).
--                       CLINIC: alta de la clínica con su ADMIN al verificar
--                       el registro (POST /auth/register/verify).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (los índices de
-- 20261101120100_dx359_audit_events_idx lo usan).
--
-- Compatible hacia atrás: solo AÑADE valores que el código anterior no conoce
-- ni usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PASSWORD_CHANGE';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'STAFF_INVITATION';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'CLINIC';
