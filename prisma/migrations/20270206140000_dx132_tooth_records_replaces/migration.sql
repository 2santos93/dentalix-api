-- DX-132: re-copia del espejo del plan tras una anulación. Si el registro que
-- un ítem DONE copió al odontograma se anuló y el ítem vuelve a marcarse
-- realizado, se INSERTA un registro nuevo (append-only: nada se modifica) que
-- dice a qué copia anulada sustituye. El índice único del espejo pasa a ser
-- (tenantId, sourcePlanItemId, replacesRecordId) NULLS NOT DISTINCT (siguiente
-- migración): la primera copia (replacesRecordId NULL) sigue siendo única y
-- cada copia anulada se sustituye una sola vez.
--
-- Columna nullable sin DEFAULT: solo catálogo, sin reescribir la tabla.
-- FK compuesta al registro sustituido del MISMO paciente y clínica (molde de
-- "tooth_records_voidsRecordId_fkey", NO ACTION por la purga y la fusión de
-- pacientes, que cambian el paciente de toda la cadena en una sentencia).
-- CHECK: solo una copia del plan sustituye, y nunca a sí misma.
-- NOT VALID aquí; VALIDATE en 20270206140300 (DB-025 / DX-148). Todas las
-- filas previas tienen "replacesRecordId" NULL.
-- Vuelta atrás: ALTER TABLE "tooth_records" DROP COLUMN "replacesRecordId";
-- (arrastra la FK y el CHECK).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "tooth_records" ADD COLUMN "replacesRecordId" UUID;

ALTER TABLE "tooth_records" ADD CONSTRAINT "tooth_records_replacesRecordId_fkey"
  FOREIGN KEY ("tenantId", "patientId", "replacesRecordId")
  REFERENCES "tooth_records"("tenantId", "patientId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;

ALTER TABLE "tooth_records" ADD CONSTRAINT "tooth_records_replaces_check" CHECK (
  "replacesRecordId" IS NULL
  OR ("sourcePlanItemId" IS NOT NULL AND "replacesRecordId" <> "id")
) NOT VALID;
