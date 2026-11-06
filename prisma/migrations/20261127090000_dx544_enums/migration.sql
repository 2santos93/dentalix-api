-- DX-544: valor de auditoría del expediente de rayos X de cada sede.
--
-- Cambios:
--   AuditResourceType   RADIOLOGY_RECORD (alta, edición y anulación de una
--                       licencia o de un control de calidad).
--
-- ADD VALUE va en su propio fichero: el valor nuevo no se puede usar en la
-- misma transacción que lo crea (su índice parcial de audit_events va en
-- 20261127090200_dx544_audit_events_idx).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.
-- Vuelta atrás: Postgres no quita valores de un enum; el valor sin uso no
-- molesta al código anterior.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'RADIOLOGY_RECORD';
