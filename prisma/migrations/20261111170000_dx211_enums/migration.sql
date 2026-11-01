-- DX-211: valor de auditoría de los sillones (gabinetes) de cada sede.
--
-- Cambios:
--   AuditResourceType   CHAIR (alta, edición, orden, desactivación y
--                       reactivación de un sillón).
--
-- ADD VALUE va en su propio fichero: el valor nuevo no se puede usar en la
-- misma transacción que lo crea (su índice parcial de audit_events va en
-- 20261111170300_dx211_audit_events_idx).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.
-- Vuelta atrás: Postgres no quita valores de un enum; el valor sin uso no
-- molesta al código anterior.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'CHAIR';
