-- DX-571: conciliación de transferencias y pagos móviles contra el extracto
-- del banco. Tres recursos de auditoría nuevos:
--   BANK_ACCOUNT               alta y cambios de una cuenta de conciliación
--                              (nombre, moneda, medios, tolerancia, mapeo).
--   BANK_STATEMENT_IMPORT      importación confirmada de un extracto (hash del
--                              fichero y contadores; nunca su contenido).
--   BANK_RECONCILIATION_MATCH  emparejado manual de un movimiento con un abono
--                              y su deshacer.
--
-- Solo los valores: su índice parcial de audit_events va en
-- 20270122090100 (un valor nuevo no se puede usar en la transacción que lo
-- crea). Aditiva. IF NOT EXISTS: idempotente.

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'BANK_ACCOUNT';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'BANK_STATEMENT_IMPORT';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'BANK_RECONCILIATION_MATCH';
