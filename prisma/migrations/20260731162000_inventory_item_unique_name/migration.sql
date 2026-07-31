-- Add a PARTIAL unique index so two *active* inventory items in the same
-- tenant can't share a name, while soft-deleted (deletedAt IS NOT NULL) rows
-- never block re-using a freed name. Every inventory read already filters
-- `deletedAt: null`, so constraining only active rows matches the read
-- semantics -- same pattern as patients_tenant_doc_key.
--
-- Prisma's DSL cannot express the WHERE, so schema.prisma keeps
--   @@unique([tenantId, name], map: "inventory_items_tenantId_name_key")
-- and this migration adds the partial predicate by hand (same name+columns ->
-- no drift). Do NOT accept a migrate-dev diff that recreates it as full.

-- CreateIndex (partial/soft-delete safe unique)
CREATE UNIQUE INDEX "inventory_items_tenantId_name_key"
  ON "inventory_items" ("tenantId", "name")
  WHERE "deletedAt" IS NULL;

-- Grants: none required (privileges are on the table; owner role "dentalix"
-- runs this). RLS on inventory_items unchanged.
