-- DX-051: imputación de abonos a ítems del plan. Valor de enum nuevo.
--
-- Cambios:
--   AuditResourceType   PAYMENT_ALLOCATION: reasignación manual (ADMIN) de la
--                       imputación de un abono a los ítems de su plan.
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (el índice de
-- 20261026100400_dx051_audit_events_idx lo usa).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no conoce
-- ni usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PAYMENT_ALLOCATION';
