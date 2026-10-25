-- DX-246: índice para la FK de entregas; aditivo, sin bloquear escrituras.
-- CONCURRENTLY va solo en el fichero (DB-025): varias sentencias se ejecutan
-- como una transacción implícita y PostgreSQL rechaza el índice concurrente.
-- Si se interrumpe y deja un índice INVALID, DROP INDEX CONCURRENTLY,
-- prisma migrate resolve --rolled-back y reintentar; IF NOT EXISTS no lo repara.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "post_op_instruction_deliveries_location_idx" ON "post_op_instruction_deliveries" ("tenantId", "locationId");
