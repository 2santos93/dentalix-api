-- DX-038: destino de la FK compuesta (tenantId, patientId, clinicalEntryId) de
-- clinical_entry_addenda: una adenda solo puede colgar de una evolución del
-- MISMO paciente y la MISMA clínica (IDOR imposible también en la BD).
-- CONCURRENTLY (DB-025): no bloquea escrituras en la historia clínica; por eso
-- es la ÚNICA sentencia del fichero (Prisma la ejecuta fuera de transacción).
-- Si falla deja un índice INVALID: DROP INDEX CONCURRENTLY,
-- `prisma migrate resolve --rolled-back` y reintentar.
CREATE UNIQUE INDEX CONCURRENTLY "clinical_entries_tenantId_patientId_id_key" ON "clinical_entries"("tenantId", "patientId", "id");
