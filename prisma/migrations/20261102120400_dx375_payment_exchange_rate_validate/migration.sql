-- DX-375: valida el CHECK de la tasa congelada que 20261102120000 añadió NOT
-- VALID. VALIDATE de un CHECK toma SHARE UPDATE EXCLUSIVE: lee la tabla sin
-- bloquear las escrituras de los abonos. Tras el relleno todas las filas
-- cumplen (las cuatro columnas de la tasa siguen NULL en las anteriores).
--
-- La FK payments_exchange_rate_currency_fkey se queda NOT VALID a propósito:
-- ya comprueba toda fila nueva o cambiada, y las existentes solo tienen la
-- moneda del propio abono (relleno), que ya es de `currencies` por su FK.
-- Validarla con "payments" en FORCE haría que un owner sin BYPASSRLS validara
-- sin ver filas (DX-134, test/migrations/fk-under-force.spec.ts), y quitar
-- FORCE para validarla bloquearía los abonos durante el recorrido.
--
-- lock_timeout 5 s; para reintentar, `prisma migrate resolve --rolled-back
-- 20261102120400_dx375_payment_exchange_rate_validate` y `deploy`.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_exchange_rate_check";
