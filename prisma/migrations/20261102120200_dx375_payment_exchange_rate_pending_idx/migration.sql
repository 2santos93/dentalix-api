-- DX-375: abonos vivos por congelar (sin tasa, o anteriores en otra moneda
-- que su destino), para el barrido de cada minuto, clínica por clínica y del
-- más reciente al más antiguo. Parcial: tras el relleno solo entran los que
-- de verdad esperan una tasa, así que el índice es pequeño.
-- CONCURRENTLY (DB-025): no bloquea las escrituras de los abonos; por eso es
-- la ÚNICA sentencia del fichero (Prisma la ejecuta fuera de transacción).
-- Si falla deja un índice INVALID: DROP INDEX CONCURRENTLY,
-- `prisma migrate resolve --rolled-back` y reintentar.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "payments_exchange_rate_pending_idx" ON "payments" ("tenantId", "createdAt") WHERE "deletedAt" IS NULL AND "exchangeRateFrom" IS NULL AND ("exchangeRateCurrency" IS NULL OR "currency" <> "exchangeRateCurrency");
