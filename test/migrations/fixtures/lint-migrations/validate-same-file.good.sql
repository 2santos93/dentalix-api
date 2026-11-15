-- La migración POSTERIOR valida la restricción añadida NOT VALID en otra.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "tooth_records" VALIDATE CONSTRAINT "tooth_records_voids_record_fkey";
