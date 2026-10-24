-- SEC-050: lado hijo de la FK `cancellation_fees_voided_by_fkey` (parcial:
-- casi ningún cargo se anula). CONCURRENTLY, única sentencia. Aditivo.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "cancellation_fees_voided_by_idx" ON "cancellation_fees" ("voidedById") WHERE "voidedById" IS NOT NULL;
