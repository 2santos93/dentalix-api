-- Convert the full unique index tenant_domains_host_key into a PARTIAL one
-- (WHERE "deletedAt" IS NULL). tenant_domains is soft-deleted and every read
-- filters `deletedAt: null`; a FULL unique index means a soft-deleted host can
-- NEVER be re-registered. Making the index partial matches the read semantics
-- -- same rationale as 20260722184531_partial_unique_indexes.
--
-- Prisma keeps `host String @unique`; this migration recreates the index with
-- the SAME name+column plus the partial predicate -> no drift. Do NOT accept a
-- migrate-dev diff that recreates this as a full index.

-- DropIndex (the full unique index Prisma's @unique originally generated)
DROP INDEX "tenant_domains_host_key";

-- CreateIndex (partial/soft-delete safe unique)
CREATE UNIQUE INDEX "tenant_domains_host_key"
  ON "tenant_domains" ("host")
  WHERE "deletedAt" IS NULL;

-- Grants: none required. tenant_domains has NO RLS by design (host->tenant is
-- resolved BEFORE a tenant is known); this index change doesn't affect that.
-- Safe against existing data: the old full index already guaranteed host
-- globally unique, so the partial index can never find a violation on recreate.
