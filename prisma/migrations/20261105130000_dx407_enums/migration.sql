-- DX-407: valor de enum nuevo de la hoja de sedación en la evolución.
--
-- Cambios:
--   AuditResourceType   SEDATION_RECORD (hoja de sedación de una evolución:
--                       valoración, checklist, fármacos, constantes y egreso).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (el índice de
-- 20261105130100_dx407_audit_events_idx lo usa).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no conoce
-- ni usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'SEDATION_RECORD';
