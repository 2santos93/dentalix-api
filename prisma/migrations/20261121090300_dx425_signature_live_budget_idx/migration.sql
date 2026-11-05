-- DX-425 (DB-061): un solo enlace vivo (sin firmar ni anular) por paciente y
-- plan para el presupuesto remoto (BUDGET). Mismo criterio y mismas
-- instrucciones de recuperación que 20261121090200_dx425_signature_live_consent_idx
-- (el DROP INDEX CONCURRENTLY previo es obligatorio: con IF NOT EXISTS un índice INVALID haría que el reintento no hiciera nada; DROP INDEX CONCURRENTLY "signature_requests_live_budget_key", anular los
-- duplicados, `migrate resolve --rolled-back` y reintentar).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "signature_requests_live_budget_key" ON "signature_requests" ("tenantId", "patientId", "treatmentPlanId") WHERE "type" = 'BUDGET' AND "signedAt" IS NULL AND "revokedAt" IS NULL;
