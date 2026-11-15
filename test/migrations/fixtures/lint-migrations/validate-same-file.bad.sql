-- NOT VALID y su VALIDATE en el mismo fichero (como DX-120).
SET LOCAL lock_timeout = '5s';
ALTER TABLE "tooth_records"
  ADD CONSTRAINT "tooth_records_voids_record_fkey"
  FOREIGN KEY ("tenantId", "patientId", "voidsRecordId")
  REFERENCES "tooth_records"("tenantId", "patientId", "id") NOT VALID;
ALTER TABLE "tooth_records" VALIDATE CONSTRAINT "tooth_records_voids_record_fkey";
