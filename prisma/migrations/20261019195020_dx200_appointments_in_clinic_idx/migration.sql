-- DX-200: panel «En clínica» = citas de UNA sede y un día civil en llegó, en
-- sillón o listo para cobrar. Parcial: solo esas filas (pocas a la vez).
-- CONCURRENTLY para no bloquear la agenda, única sentencia (no puede ir en
-- transacción). Aditivo.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "appointments_tenant_location_in_clinic_idx" ON "appointments" ("tenantId", "locationId", "start") WHERE "status" IN ('ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT') AND "deletedAt" IS NULL;
