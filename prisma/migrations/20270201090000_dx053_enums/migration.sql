-- DX-053: exportación de los datos de la clínica (ZIP de CSV).
--   AuditResourceType CLINIC_EXPORT       pedir una exportación (CREATE) y
--                                         descargarla (EXPORT, con el tamaño).
--   EmailTemplate     clinic-export-ready aviso a los ADMIN de que está lista.
--
-- Solo los valores: el índice parcial de audit_events va en
-- 20270201090100 (un valor nuevo no se puede usar en la transacción que lo
-- crea). Aditiva. IF NOT EXISTS: idempotente.
-- Vuelta atrás: no hace falta (un valor de enum sin usar no molesta).

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'CLINIC_EXPORT';
ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'clinic-export-ready';
