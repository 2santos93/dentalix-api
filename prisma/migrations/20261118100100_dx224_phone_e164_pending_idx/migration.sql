-- DX-224 (ronda 2): lo PENDIENTE del relleno de `phoneE164` (con teléfono, sin
-- E.164 y sin marca de revisado) por (tenant, id), para que el barrido horario
-- toque solo el residuo y no recorra a todos los pacientes. Parcial y
-- CONCURRENTLY (una sentencia por fichero, sin transacción). Aditivo.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "patients_tenant_phone_e164_pending_idx" ON "patients" ("tenantId", "id") WHERE "phone" IS NOT NULL AND "phoneE164" IS NULL AND "phoneE164CheckedAt" IS NULL;
