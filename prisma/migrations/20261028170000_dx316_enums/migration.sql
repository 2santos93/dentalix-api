-- DX-316 (G1.5): calendario de días hábiles y festivos de la sede. Valor de
-- enum nuevo.
--
-- Cambios:
--   AuditResourceType   LOCATION_CALENDAR: cambio del calendario de una sede
--                       (días hábiles de la semana, festivos e importaciones;
--                       ADMIN).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (el índice de
-- 20261028170100_dx316_audit_events_idx lo usa).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no conoce
-- ni usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'LOCATION_CALENDAR';
