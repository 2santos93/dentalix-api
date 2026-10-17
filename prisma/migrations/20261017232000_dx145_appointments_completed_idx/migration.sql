-- DX-145: «sede de la deuda» de la cartera por antigüedad = la de la última
-- cita ATENDIDA de cada paciente. Parcial (solo COMPLETED y vivas) y con
-- `locationId` incluido: la cartera lee la cita más reciente de cada deudor
-- con un Index Only Scan, sin ordenar todas sus citas. Aditivo; CONCURRENTLY
-- para no bloquear la agenda, única sentencia (no puede ir en transacción).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "appointments_tenant_patient_completed_idx" ON "appointments" ("tenantId", "patientId", "start" DESC, "id" DESC) INCLUDE ("locationId") WHERE "status" = 'COMPLETED' AND "deletedAt" IS NULL;
