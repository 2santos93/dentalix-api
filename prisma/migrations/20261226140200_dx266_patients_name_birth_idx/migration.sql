-- DX-266: «Posibles duplicados» por nombre + fecha de nacimiento. Agrupa los
-- pacientes vivos por (clínica, fecha de nacimiento, nombre completo
-- normalizado sin tildes ni mayúsculas, dx_search_normalize) leyendo este
-- índice en orden, sin comparar cada paciente con todos. patients es una
-- tabla caliente: CONCURRENTLY, solo en su fichero (README, «Índices»).
CREATE INDEX CONCURRENTLY "patients_tenant_birth_name_live_idx"
  ON "patients" ("tenantId", "birthDate", public.dx_search_normalize("firstName" || ' ' || "lastName"))
  WHERE "deletedAt" IS NULL AND "birthDate" IS NOT NULL;
