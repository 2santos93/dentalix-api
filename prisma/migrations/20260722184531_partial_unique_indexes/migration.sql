-- Convert full unique indexes to PARTIAL (soft-delete safe) unique indexes.
--
-- tenants.subdomain and users.email are @unique in schema.prisma (Prisma has
-- no schema-DSL support for partial/filtered unique indexes), but every read
-- filters `deletedAt: null` (soft delete). A full unique index means a
-- soft-deleted row's subdomain/email can NEVER be reused, and the
-- check-then-create in RegisterClinicUseCase can pass its dedup check
-- (which correctly filters deletedAt: null) and then hit this constraint on
-- an unrelated, already-soft-deleted row -> 500 instead of 409.
--
-- Making the index partial (WHERE "deletedAt" IS NULL) means only *active*
-- rows are constrained, matching the soft-delete read semantics exactly.
-- The index names are kept identical to what Prisma's `@unique` generates
-- (tenants_subdomain_key / users_email_key) so `prisma migrate deploy` /
-- `prisma migrate status` see no drift against the applied migration
-- history. `schema.prisma` intentionally keeps `@unique` (Prisma cannot
-- express the WHERE clause), so a bare `prisma migrate dev` run in the
-- future may propose to "fix" these back to full indexes -- do NOT accept
-- that diff; regenerate this migration's WHERE clause instead.

-- DropIndex
DROP INDEX "tenants_subdomain_key";

-- CreateIndex (partial/soft-delete safe)
CREATE UNIQUE INDEX "tenants_subdomain_key" ON "tenants"("subdomain") WHERE "deletedAt" IS NULL;

-- DropIndex
DROP INDEX "users_email_key";

-- CreateIndex (partial/soft-delete safe)
CREATE UNIQUE INDEX "users_email_key" ON "users"("email") WHERE "deletedAt" IS NULL;
