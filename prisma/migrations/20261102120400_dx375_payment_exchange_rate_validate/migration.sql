-- DX-375: valida el CHECK y la FK de la tasa congelada que 20261102120000
-- añadió NOT VALID. VALIDATE toma SHARE UPDATE EXCLUSIVE: lee la tabla sin
-- bloquear las escrituras de los abonos. Tras el relleno todas las filas
-- cumplen (las cuatro columnas de la tasa siguen NULL en las anteriores).
-- lock_timeout 5 s; para reintentar, `prisma migrate resolve --rolled-back
-- 20261102120400_dx375_payment_exchange_rate_validate` y `deploy`.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_exchange_rate_check";
ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_exchange_rate_currency_fkey";
