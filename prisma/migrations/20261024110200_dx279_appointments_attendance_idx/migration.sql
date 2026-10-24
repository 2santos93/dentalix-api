-- DX-279: resumen de asistencia del paciente (últimos 12 meses) e insignia de
-- la agenda = inasistencias y cancelaciones tardías de un paciente (o de un
-- lote de pacientes) por sede, desde una fecha. Parcial: solo esas filas, que
-- son pocas. CONCURRENTLY para no bloquear la agenda, única sentencia (no puede
-- ir en transacción). Aditivo.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "appointments_tenant_patient_incidents_idx" ON "appointments" ("tenantId", "patientId", "start") INCLUDE ("locationId", "status", "lateCancellation") WHERE "deletedAt" IS NULL AND ("status" = 'NO_SHOW' OR "lateCancellation" IS TRUE);
