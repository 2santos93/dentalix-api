-- Idempotency-Key dedup for POST payments (prevent DUPLICATE PAYMENTS on
-- double-submit/retry). A client sends an Idempotency-Key (UUID) header; the
-- key is stored here and a replay of the same key returns the existing row
-- instead of inserting a second one (see RecordPaymentUseCase /
-- PrismaPaymentRepository.findByIdempotencyKey).

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex (partial): only NON-NULL keys are constrained, so legacy rows
-- and any write without the header (idempotencyKey IS NULL) are unaffected,
-- while a non-null key is unique PER TENANT. The predicate intentionally does
-- NOT include `deletedAt IS NULL` -- the key must stay unique for the tenant
-- for all time so a replay of a later-voided payment returns the same row
-- rather than creating a duplicate. A concurrent duplicate INSERT trips this
-- index -> Prisma P2002 -> the global PrismaExceptionFilter maps it to 409.
--
-- Prisma's schema DSL cannot express the WHERE clause, so schema.prisma keeps
-- `@@unique([tenantId, idempotencyKey], map: "payments_tenant_idempotency_key")`
-- (no WHERE) and this migration adds the partial predicate by hand. Same
-- name+columns as the schema declares, so `prisma migrate status` /
-- `migrate deploy` see no drift -- same rationale as
-- 20260722184531_partial_unique_indexes and
-- 20260726010000_payments_tenant_paidat_index.
CREATE UNIQUE INDEX "payments_tenant_idempotency_key" ON "payments" ("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
