-- DX-191: un implante ligado a un ítem del plan apunta a un ítem de la MISMA
-- clínica (SEC-004). Que el ítem sea de un plan del MISMO paciente lo comprueba
-- el caso de uso (el ítem no lleva el paciente). RESTRICT: un ítem con un
-- implante registrado es historia clínica y no se borra en duro.
-- NOT VALID + VALIDATE (DB-025): la tabla es nueva y está vacía, pero así el
-- patrón es el mismo que en el resto de FK añadidas tras crear la tabla.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "patient_implants" ADD CONSTRAINT "patient_implants_tenantId_treatmentPlanItemId_fkey"
  FOREIGN KEY ("tenantId", "treatmentPlanItemId")
  REFERENCES "treatment_plan_items"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "patient_implants" VALIDATE CONSTRAINT "patient_implants_tenantId_treatmentPlanItemId_fkey";
