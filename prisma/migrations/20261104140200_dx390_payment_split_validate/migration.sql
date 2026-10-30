-- DX-390: valida el CHECK payments_split_check que 20261104140000 añadió NOT
-- VALID. VALIDATE de un CHECK toma SHARE UPDATE EXCLUSIVE: lee la tabla sin
-- bloquear las escrituras de los abonos. Todas las filas anteriores tienen las
-- dos columnas a NULL, así que cumplen.
--
-- La FK payments_split_fkey se queda NOT VALID a propósito (como
-- payments_payment_method_fkey, DX-377): ya comprueba toda fila nueva o
-- cambiada, y no hay filas anteriores con "splitId". Validarla con "payments"
-- en FORCE haría que un owner sin BYPASSRLS validara sin ver filas (DX-134,
-- test/migrations/fk-under-force.spec.ts).
--
-- lock_timeout 5 s; para reintentar, `prisma migrate resolve --rolled-back
-- 20261104140200_dx390_payment_split_validate` y `deploy`.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_split_check";
