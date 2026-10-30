-- DX-377: valor de enum nuevo.
--
-- Cambios:
--   AuditResourceType   PAYMENT_METHOD: alta y cambio de un medio de pago del
--                       catálogo de la clínica.
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (el índice de
-- 20261103115900_dx377_audit_events_idx lo usa).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no conoce
-- ni usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PAYMENT_METHOD';
