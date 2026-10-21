-- DX-233: valor de auditoría del horario de los profesionales.
--
-- Cambios:
--   AuditResourceType   PROVIDER_SCHEDULE (horario semanal de un profesional,
--                       sus excepciones por fecha y el modo estricto de la
--                       clínica).
--
-- ADD VALUE va en su propio fichero: el valor nuevo no se puede usar en la
-- misma transacción que lo crea (su índice parcial de audit_events va en
-- 20261020220200_dx233_audit_events_idx).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PROVIDER_SCHEDULE';
