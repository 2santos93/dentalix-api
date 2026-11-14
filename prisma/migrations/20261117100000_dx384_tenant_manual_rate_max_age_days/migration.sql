-- DX-384: con fuente MANUAL, una clínica que no registró la tasa de un día
-- (un sábado, un festivo) dejaba «sin tasa» todos los abonos de ese día. Ahora
-- puede usar la última tasa manual registrada con fecha anterior (o igual) al
-- día del abono, siempre que no sea más antigua que "manualRateMaxAgeDays"
-- días de calendario. 0 = solo la tasa del día exacto (lo de antes).
--
-- Expand, solo `tenants`: una columna NOT NULL con un DEFAULT constante (3, el
-- valor de plataforma) y su CHECK 0..30.
--   - En PG 16, ADD COLUMN con un DEFAULT constante y NOT NULL solo toca el
--     catálogo (attmissingval): no reescribe la tabla.
--   - El CHECK se valida en la misma sentencia, bajo el ACCESS EXCLUSIVE que
--     ya toma el ADD COLUMN. `tenants` tiene una fila por clínica: son
--     milisegundos, así que no se separa en NOT VALID + VALIDATE (como
--     DX-324 y DX-328).
--   - Las réplicas anteriores no conocen la columna: una clínica que crean
--     recibe el default, y sus abonos siguen con la regla del día exacto
--     porque el código anterior nunca la lee.
--
-- El abono ya guarda el día de la tasa que congeló ("payments"."exchangeRateDate",
-- DX-375): con esta regla pasa a ser el de la tasa USADA (puede ser anterior al
-- del abono), que es también el que identifican el índice parcial
-- payments_exchange_rate_manual_idx y el trigger de «tasa ya usada». No hay
-- columna nueva en "payments" ni relleno: los abonos históricos ya la tienen
-- igual al día del abono, que era el de su tasa.
--
-- lock_timeout 5 s, como el resto de ALTER de `tenants`: toda petición la lee
-- al resolver la clínica. Si falla, se reintenta el deploy.
--
-- Sin trigger UTC (DX-226): no hay columnas de fecha. RLS: `tenants` es global
-- (sin RLS), no cambia. Grants: no aplica (`tenants` ya concedida a
-- dentalix_app; columna nueva de tabla existente).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants"
  ADD COLUMN "manualRateMaxAgeDays" INTEGER NOT NULL DEFAULT 3,
  ADD CONSTRAINT "tenants_manual_rate_max_age_days_check"
    CHECK ("manualRateMaxAgeDays" BETWEEN 0 AND 30);
