-- DX-274: gastos de la sede y salidas de caja menor. Valores de enum nuevos.
--
-- Cambios:
--   CashAdjustmentKind  OUTFLOW_VOID: anulación, con la caja ya cerrada, de una
--                       salida de caja menor (ajuste positivo en la caja
--                       abierta de quien anula, o pendiente de la siguiente).
--   AuditResourceType   EXPENSE: alta, edición, soporte, pagos y anulación de
--                       un gasto.
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (el CHECK de 20261024150200_dx274_cash_adjustment_outflow
-- y el índice de 20261024150300_dx274_audit_events_idx lo usan).
--
-- Compatible hacia atrás: solo AÑADE valores que el código anterior no conoce
-- ni usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "CashAdjustmentKind" ADD VALUE IF NOT EXISTS 'OUTFLOW_VOID';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'EXPENSE';
