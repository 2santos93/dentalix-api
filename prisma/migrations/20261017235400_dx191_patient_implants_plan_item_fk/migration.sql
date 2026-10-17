-- DX-191: un implante ligado a un ítem del plan apunta a un ítem de la MISMA
-- clínica (SEC-004). Que el ítem sea de un plan del MISMO paciente lo comprueba
-- el caso de uso (el ítem no lleva el paciente). RESTRICT: un ítem con un
-- implante registrado es historia clínica y no se borra en duro.
-- NOT VALID + VALIDATE (DB-025): el ALTER no recorre la tabla con el bloqueo
-- fuerte.
-- FK sobre tablas con RLS FORCE (DX-134, README «Despliegue: roles de la BD»):
-- con un owner sin superusuario ni BYPASSRLS, el VALIDATE vería 0 filas bajo
-- FORCE. Se quita FORCE a la hija y a la referenciada solo durante esta
-- migración (una transacción) y se devuelve al final.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "patient_implants" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_items" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "patient_implants" ADD CONSTRAINT "patient_implants_tenantId_treatmentPlanItemId_fkey"
  FOREIGN KEY ("tenantId", "treatmentPlanItemId")
  REFERENCES "treatment_plan_items"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "patient_implants" VALIDATE CONSTRAINT "patient_implants_tenantId_treatmentPlanItemId_fkey";

ALTER TABLE "treatment_plan_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_implants" FORCE ROW LEVEL SECURITY;
