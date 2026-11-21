-- DX-586: valida el CHECK del momento de la tasa
-- (payments_exchange_rate_moment_check) que 20270128140000 añadió NOT VALID.
-- VALIDATE de un CHECK toma SHARE UPDATE EXCLUSIVE: lee "payments" sin
-- bloquear las escrituras de los abonos. Todas las filas cumplen: las tres
-- columnas nuevas siguen NULL en los abonos anteriores. Va en su propio
-- fichero para no retener los bloqueos de las tasas manuales mientras recorre
-- "payments".
--
-- lock_timeout 5 s; para reintentar, `prisma migrate resolve --rolled-back
-- 20270128140300_dx586_rate_moment_validate` y `deploy`.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_exchange_rate_moment_check";
