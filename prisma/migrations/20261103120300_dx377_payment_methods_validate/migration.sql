-- DX-377: valida los CHECK de la referencia que 20261103120000 añadió NOT
-- VALID. VALIDATE de un CHECK toma SHARE UPDATE EXCLUSIVE: lee la tabla sin
-- bloquear las escrituras de los abonos. Todas las filas anteriores tienen las
-- columnas de la referencia a NULL, así que cumplen.
--
-- La FK payments_payment_method_fkey se queda NOT VALID a propósito (como
-- payments_exchange_rate_currency_fkey, DX-375): ya comprueba toda fila nueva o
-- cambiada, y el relleno (20261103120100) solo escribe ids de medios de la
-- MISMA clínica. Validarla con "payments" en FORCE haría que un owner sin
-- BYPASSRLS validara sin ver filas (DX-134, test/migrations/fk-under-force.spec.ts),
-- y quitar FORCE para validarla bloquearía los abonos durante el recorrido.
--
-- lock_timeout 5 s; para reintentar, `prisma migrate resolve --rolled-back
-- 20261103120300_dx377_payment_methods_validate` y `deploy`.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_reference_check";
ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_duplicate_reference_reason_check";
