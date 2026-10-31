-- DX-360: valores de enum nuevos para auditar la configuración de la clínica.
--
-- Cambios:
--   AuditResourceType   LOCATION_SCHEDULE      horario de atención de una sede
--                                              (PUT /locations/schedule).
--                       REMINDER_SETTINGS      recordatorios de una sede
--                                              (PUT /reminder-settings/:locationId).
--                       PRIVACY_POLICY         versión publicada de la política
--                                              de tratamiento de datos.
--                       APPOINTMENT_TYPE       catálogo de tipos de cita.
--                       PAYER                  catálogo de pagadores.
--                       CONSENT_TEMPLATE       plantillas de consentimiento.
--                       PRESCRIPTION_TEMPLATE  plantillas de receta.
--                       INVENTORY_ITEM         artículos del inventario.
--                       INVENTORY_MOVEMENT     movimientos de stock.
--   (LOCATION y TENANT_DOMAIN ya existían: alta de sede y de dominio.)
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (los índices de
-- 20261111116100_dx360_audit_events_idx lo usan).
--
-- Fecha: posterior a las migraciones de main en el momento de la rama
-- (20261110100100, DX-470).
--
-- Compatible hacia atrás: solo AÑADE valores que el código anterior no conoce
-- ni usa. Sin rollback de ADD VALUE en Postgres: un valor sin filas es inocuo.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'LOCATION_SCHEDULE';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'REMINDER_SETTINGS';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PRIVACY_POLICY';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'APPOINTMENT_TYPE';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PAYER';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'CONSENT_TEMPLATE';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PRESCRIPTION_TEMPLATE';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'INVENTORY_ITEM';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'INVENTORY_MOVEMENT';
