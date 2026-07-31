-- Convert the full unique index clinic_memberships_tenantId_userId_key into a
-- PARTIAL one (WHERE "deletedAt" IS NULL). deactivateById soft-deletes a
-- membership (sets deletedAt); with a FULL unique index that soft-deleted row
-- permanently occupies (tenantId, userId) and blocks EVER re-adding that user.
-- Every membership read already filters `deletedAt: null`, so constraining only
-- active rows matches the read semantics -- same rationale as
-- 20260722184531_partial_unique_indexes (users_email_key / tenants_subdomain_key).
--
-- Prisma keeps @@unique([tenantId, userId]); this migration recreates the index
-- with the SAME name+columns plus the partial predicate -> no drift. Do NOT
-- accept a migrate-dev diff that recreates this as a full index.

-- DropIndex (the full unique index Prisma's @@unique originally generated)
DROP INDEX "clinic_memberships_tenantId_userId_key";

-- CreateIndex (partial/soft-delete safe unique)
CREATE UNIQUE INDEX "clinic_memberships_tenantId_userId_key"
  ON "clinic_memberships" ("tenantId", "userId")
  WHERE "deletedAt" IS NULL;

-- Grants: none required (privileges are on the table; owner role "dentalix"
-- runs this). RLS/tenant_isolation on clinic_memberships is unchanged.
-- Safe against existing data: the old full index already guaranteed
-- (tenantId,userId) globally unique, so the stricter partial index can never
-- find a violation on recreate.
