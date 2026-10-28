-- DX-328: mayoría de edad por clínica. Valor de enum nuevo.
--
-- Cambios:
--   AuditResourceType   CLINIC_SETTINGS: cambio de los ajustes de la clínica
--                       (de momento, su mayoría de edad; ADMIN).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (el índice de
-- 20261028160100_dx328_audit_events_idx lo usa).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no conoce
-- ni usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'CLINIC_SETTINGS';
