-- DX-120: la anulación apunta a un registro del mismo paciente y la misma
-- clínica. NO ACTION (no RESTRICT): la comprobación va al final de la
-- sentencia, así la purga del superusuario puede borrar el registro y su
-- anulación en el mismo DELETE.
-- NOT VALID + VALIDATE (DB-025): el ALTER no recorre la tabla con el bloqueo
-- fuerte; todas las filas previas tienen "voidsRecordId" NULL.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "tooth_records" ADD CONSTRAINT "tooth_records_voidsRecordId_fkey"
  FOREIGN KEY ("tenantId", "patientId", "voidsRecordId")
  REFERENCES "tooth_records"("tenantId", "patientId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "tooth_records" VALIDATE CONSTRAINT "tooth_records_voidsRecordId_fkey";
