-- DX-377: búsqueda de referencias repetidas al registrar un abono (mismo medio
-- y referencia normalizada en la clínica, en una ventana de "paidAt"). Sirve
-- también de lado hijo de la FK compuesta payments_payment_method_fkey.
-- CONCURRENTLY (DB-025): no bloquea las escrituras de los abonos; por eso es
-- la ÚNICA sentencia del fichero (Prisma la ejecuta fuera de transacción).
-- Si falla deja un índice INVALID: DROP INDEX CONCURRENTLY,
-- `prisma migrate resolve --rolled-back` y reintentar.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "payments_tenant_method_reference_idx" ON "payments" ("tenantId", "paymentMethodId", "referenceNormalized", "paidAt");
