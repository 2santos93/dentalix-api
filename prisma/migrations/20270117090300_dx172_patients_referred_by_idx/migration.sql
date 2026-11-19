-- DX-172: «Ha recomendado a N pacientes», la fusión y la supresión buscan por
-- el referente; es también el lado hijo de patients_referred_by_fkey. Tabla
-- caliente (DX-148): CONCURRENTLY, sola en su fichero.
-- Vuelta atrás: DROP INDEX CONCURRENTLY "patients_tenant_referred_by_idx".
CREATE INDEX CONCURRENTLY IF NOT EXISTS "patients_tenant_referred_by_idx" ON "patients"("tenantId", "referredByPatientId") WHERE "referredByPatientId" IS NOT NULL;
