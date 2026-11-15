-- DX-266: los absorbidos por una fusión: lado hijo de patients_merged_into_fkey
-- (la fusión siguiente reapunta los que apuntaban al absorbido) y la búsqueda
-- que lleva del nombre o documento antiguo al paciente que se conserva. Solo
-- las filas fusionadas (pocas). CONCURRENTLY, solo en su fichero.
CREATE INDEX CONCURRENTLY "patients_tenant_merged_into_idx"
  ON "patients" ("tenantId", "mergedIntoId")
  WHERE "mergedIntoId" IS NOT NULL;
