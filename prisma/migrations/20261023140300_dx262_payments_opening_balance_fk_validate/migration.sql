-- DX-262: valida payments_opening_balance_fkey (añadida NOT VALID en
-- 20261023140000) sin recorrer payments (patrón de
-- 20261022130400_dx107_patients_import_batch_fk_validate).
--
-- "openingBalanceId" nació entera a NULL y la FK NOT VALID ya se aplica a toda
-- fila nueva o modificada: no puede haber huérfanas.
--   1. ANALYZE de la columna ANTES del NO FORCE (SHARE UPDATE EXCLUSIVE, no
--      bloquea): estadística «casi todo NULL».
--   2. Con ella, la comprobación del VALIDATE usa el índice parcial
--      payments_tenant_opening_balance_idx (20261023140100): no lee la tabla.
--   3. DX-134: NO FORCE en la hija (payments) y la referenciada
--      (opening_balances) mientras se valida, y FORCE al final, en la misma
--      transacción; el ACCESS EXCLUSIVE dura lo que el VALIDATE del paso 2.
-- lock_timeout acota la espera. Compatible hacia atrás: no cambia el esquema.

SET LOCAL lock_timeout = '5s';

ANALYZE "payments" ("openingBalanceId");

ALTER TABLE "payments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "opening_balances" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_opening_balance_fkey";
ALTER TABLE "opening_balances" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
