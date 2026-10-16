-- DX-120: destino de la FK compuesta (tenantId, patientId, voidsRecordId) de
-- tooth_records: una anulación solo puede apuntar a un registro del MISMO
-- paciente y la MISMA clínica (IDOR imposible también en la BD).
-- CONCURRENTLY (DB-025): no bloquea escrituras en el odontograma; por eso es
-- la ÚNICA sentencia del fichero (Prisma la ejecuta fuera de transacción).
-- Si falla deja un índice INVALID: DROP INDEX CONCURRENTLY,
-- `prisma migrate resolve --rolled-back` y reintentar.
CREATE UNIQUE INDEX CONCURRENTLY "tooth_records_tenantId_patientId_id_key" ON "tooth_records"("tenantId", "patientId", "id");
