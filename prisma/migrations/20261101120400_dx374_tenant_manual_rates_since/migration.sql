-- DX-374 (revisión): día civil desde el que rige la tasa MANUAL de cada
-- clínica. Sin él, pasar a MANUAL dejaba «sin tasa» todos los abonos
-- históricos en otra moneda (los días anteriores no tienen tasa manual) y
-- movía hacia atrás saldos, totales e imputaciones.
--
-- Regla: la lectura de tasas de un día D usa las manuales solo si la fuente
-- es MANUAL y D >= "manualExchangeRatesSince"; los días anteriores siguen con
-- la tasa automática (caché `exchange_rate_snapshots` y, si falta, el
-- proveedor). La API lo fija al pasar a MANUAL (hoy en la zona de la sede
-- principal), lo conserva si se guarda MANUAL otra vez y lo limpia al volver a
-- AUTOMATIC.
--
-- Expand, solo `tenants`: columna DATE nullable sin default (solo catálogo,
-- no reescribe la tabla) y un CHECK que ata la columna a la fuente.
--   - Toda clínica está hoy en AUTOMATIC con la columna a NULL, así que el
--     CHECK se cumple; `tenants` tiene una fila por clínica: se valida en la
--     misma sentencia (milisegundos), como DX-324 y DX-328.
--   - Una clínica que ya estuviera en MANUAL (solo posible en una base que
--     aplicó 20261101120200 sin esta migración: ninguna en producción) recibe
--     como día de inicio el de hoy en UTC antes del CHECK, la misma regla
--     «desde ahora» que la API.
--   - El código anterior no conoce la columna: si una réplica anterior pasa
--     una clínica a MANUAL sin fijarla, el CHECK lo rechaza en vez de dejar
--     una clínica MANUAL sin día de inicio.
--
-- lock_timeout 5 s, como el resto de ALTER de `tenants`: toda petición la
-- lee al resolver la clínica. Si falla, se reintenta el deploy.
--
-- Sin trigger UTC (DX-226): es una fecha civil, no una hora. Grants: no
-- aplica.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants" ADD COLUMN "manualExchangeRatesSince" DATE;

UPDATE "tenants"
   SET "manualExchangeRatesSince" = (pg_catalog.timezone('UTC', pg_catalog.now()))::date
 WHERE "exchangeRateSource" = 'MANUAL' AND "manualExchangeRatesSince" IS NULL;

ALTER TABLE "tenants" ADD CONSTRAINT "tenants_manual_exchange_rates_since_check"
  CHECK (("exchangeRateSource" = 'MANUAL') = ("manualExchangeRatesSince" IS NOT NULL));
