-- DX-374 (porción 1 de DX-367): de dónde sale la tasa de cambio del día de
-- cada clínica.
--   - AUTOMATIC: del proveedor, cacheada en `exchange_rate_snapshots` (lo de
--     siempre);
--   - MANUAL: de `manual_exchange_rates` (migración siguiente), la que
--     registra el ADMIN para cada día y moneda.
--
-- Expand, solo `tenants`: columna NOT NULL con el default AUTOMATIC, así que
-- ninguna clínica existente cambia de comportamiento y no hace falta relleno.
--   - En PG 16, ADD COLUMN con un DEFAULT constante y NOT NULL solo toca el
--     catálogo (attmissingval): no reescribe la tabla.
--   - Una réplica anterior que crea una clínica sin nombrar la columna recibe
--     el default; las réplicas anteriores no la leen.
--
-- El tipo nuevo se crea aquí (CREATE TYPE sí se puede usar en la misma
-- transacción, a diferencia de ADD VALUE).
--
-- La tabla de tasas va en su propia migración
-- (20261101120300_dx374_manual_exchange_rates): así este ALTER, que toma
-- ACCESS EXCLUSIVE en `tenants`, no lo retiene mientras la tabla nueva espera
-- los bloqueos de sus FK.
--
-- lock_timeout 5 s, como DX-247, DX-324 y DX-328 en esta misma tabla: toda
-- petición lee `tenants` al resolver la clínica, así que mientras este ALTER
-- espera su bloqueo los lectores nuevos hacen cola detrás. Si falla, se
-- reintenta el deploy.
--
-- Sin trigger UTC (DX-226): no hay columnas de fecha. Grants: no aplica
-- (`tenants` ya concedida a dentalix_app; columna nueva de tabla existente).

SET LOCAL lock_timeout = '5s';

CREATE TYPE "ExchangeRateSource" AS ENUM ('AUTOMATIC', 'MANUAL');

ALTER TABLE "tenants"
  ADD COLUMN "exchangeRateSource" "ExchangeRateSource" NOT NULL DEFAULT 'AUTOMATIC';
