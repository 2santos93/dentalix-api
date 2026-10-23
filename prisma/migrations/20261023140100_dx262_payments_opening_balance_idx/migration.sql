-- DX-262: abonos de un saldo migrado (lo abonado en el resumen de cartera y
-- el estado de cuenta, el deshacer del lote) y lado hijo de la FK
-- payments_opening_balance_fkey (20261023140000). Parcial: solo los abonos a
-- un saldo migrado. CONCURRENTLY para no bloquear las escrituras de payments
-- (como 20261022130300_dx107_patients_import_batch_idx); única sentencia (no
-- puede ir en transacción). Si se corta, deja un índice INVALID: el IF NOT
-- EXISTS no lo repara; hay que DROP INDEX CONCURRENTLY y repetirla.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "payments_tenant_opening_balance_idx" ON "payments" ("tenantId", "openingBalanceId") WHERE "openingBalanceId" IS NOT NULL;
