-- DX-375: abonos que congelaron una tasa MANUAL, por clínica y día: es el
-- filtro con que se decide si una tasa manual ya se usó (409 al cambiarla, y
-- el trigger manual_exchange_rates_in_use_guard). Parcial: los automáticos y
-- los abonos en la moneda de su destino no entran.
-- CONCURRENTLY (DB-025): ÚNICA sentencia del fichero. Si falla deja un índice
-- INVALID: DROP INDEX CONCURRENTLY, `prisma migrate resolve --rolled-back` y
-- reintentar.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "payments_exchange_rate_manual_idx" ON "payments" ("tenantId", "exchangeRateDate") WHERE "exchangeRateSource" = 'MANUAL';
