-- DX-307: valores de enum nuevos de la anestesia local en la evolución.
--
-- Cambios:
--   AuditResourceType   ANESTHETIC_PRODUCT (catálogo de anestésicos de la
--                       clínica) y ANESTHESIA_ADMINISTRATION (anestesia
--                       registrada en una evolución).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (los índices de
-- 20261104130100_dx307_audit_events_idx lo usan).
--
-- Compatible hacia atrás: solo AÑADE valores que el código anterior no conoce
-- ni usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'ANESTHETIC_PRODUCT';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'ANESTHESIA_ADMINISTRATION';
