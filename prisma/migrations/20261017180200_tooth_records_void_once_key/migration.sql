-- DX-120: un registro del odontograma se anula UNA sola vez. Único PARCIAL
-- (solo las filas que son anulaciones); respalda en la BD la carrera de dos
-- anulaciones simultáneas (la segunda recibe 409). También sirve la búsqueda
-- "¿quién anuló este registro?".
-- CONCURRENTLY y sola en su fichero (DB-025); recuperación como en
-- 20261017180100_tooth_records_tenant_patient_id_key.
CREATE UNIQUE INDEX CONCURRENTLY "tooth_records_void_once_key" ON "tooth_records"("tenantId", "voidsRecordId") WHERE "voidsRecordId" IS NOT NULL;
