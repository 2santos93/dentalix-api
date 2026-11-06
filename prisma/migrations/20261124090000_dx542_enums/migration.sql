-- DX-542: valores de auditoría de los equipos biomédicos de cada sede.
--
-- Cambios:
--   AuditResourceType   EQUIPMENT (alta, edición y baja de un equipo) y
--                       EQUIPMENT_MAINTENANCE (registro y anulación de un
--                       mantenimiento).
--
-- ADD VALUE va en su propio fichero: el valor nuevo no se puede usar en la
-- misma transacción que lo crea (sus índices parciales de audit_events van en
-- 20261124090200_dx542_audit_events_idx).
--
-- Compatible hacia atrás: solo AÑADE valores que el código anterior no usa.
-- Vuelta atrás: Postgres no quita valores de un enum; los valores sin uso no
-- molestan al código anterior.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'EQUIPMENT';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'EQUIPMENT_MAINTENANCE';
