-- DX-374 (porción 1 de DX-367): tasa de cambio por clínica. Valor de enum
-- nuevo.
--
-- Cambios:
--   AuditResourceType   EXCHANGE_RATE: tasa de cambio manual que registra el
--                       ADMIN de la clínica (un día, una moneda).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (el índice de
-- 20261101120100_dx374_audit_events_idx lo usa).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no conoce
-- ni usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'EXCHANGE_RATE';
