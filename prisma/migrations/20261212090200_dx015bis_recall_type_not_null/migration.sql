-- DX-015-bis: cierra el relleno. Todo recall tiene tipo (NOT NULL) y hay uno
-- por paciente y TIPO; la unicidad por "kind" se suelta DESPUÉS de crear la
-- nueva, así nunca queda la tabla sin ninguna.
--
-- Falla de forma ruidosa si el relleno dejó algún recall sin tipo (una
-- clínica sin el tipo de su "kind"): no se cierra a ciegas.
--
-- patient_recalls es pequeña: CREATE UNIQUE INDEX sin CONCURRENTLY (SHARE, un
-- instante) y SET NOT NULL (ACCESS EXCLUSIVE con un recorrido corto), con
-- lock_timeout para fallar limpio. Un CHECK ve todas las filas aunque el owner
-- esté sujeto a la RLS (DX-134); el recuento previo, no, así que se comprueba
-- con el CHECK.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "patient_recalls"
  ADD CONSTRAINT "patient_recalls_type_check" CHECK ("recallTypeId" IS NOT NULL) NOT VALID;
ALTER TABLE "patient_recalls" VALIDATE CONSTRAINT "patient_recalls_type_check";
ALTER TABLE "patient_recalls" ALTER COLUMN "recallTypeId" SET NOT NULL;
ALTER TABLE "patient_recalls" DROP CONSTRAINT "patient_recalls_type_check";

CREATE UNIQUE INDEX "patient_recalls_tenant_patient_type_key"
  ON "patient_recalls"("tenantId", "patientId", "recallTypeId");
DROP INDEX "patient_recalls_tenant_patient_kind_key";
-- El nuevo cubre el lado hijo de la FK del tipo solo con el paciente delante;
-- el de 20261212090000 ("tenantId", "recallTypeId") se queda para la FK.
