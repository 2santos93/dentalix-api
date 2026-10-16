-- DX-040 (2/2): alternativas de plan (opciones A/B), presentación y rechazo.
--
-- Cambios en treatment_plans (todas las columnas nuevas son NULLABLE y sin
-- DEFAULT: Postgres no reescribe la tabla y los planes existentes quedan como
-- planes sueltos, sin grupo, sin presentar y sin rechazo):
--   optionGroupId        id del plan raíz del grupo de opciones (el raíz se
--                        apunta a sí mismo). FK COMPUESTA (tenantId,
--                        optionGroupId, patientId) → treatment_plans(tenantId,
--                        id, patientId): todas las opciones de un grupo son de
--                        la MISMA clínica y del MISMO paciente.
--   optionLabel          "Opción A: implante" (1–60 caracteres).
--   presentedAt          cuándo se presentó al paciente.
--   presentedLocationId  en qué sede (FK compuesta a locations).
--   rejectedAt           cuándo lo rechazó.
--   rejectionReason      por qué (enum TreatmentPlanRejectionReason).
--   rejectionNote        detalle (obligatorio con OTHER, hasta 500).
--
-- Índices: uno por cada filtro nuevo — las opciones de un grupo, la lista de
-- presupuestos por seguir (tenantId, status, presentedAt) y la sede de
-- presentación (también lado hijo de su FK).
--
-- Trigger: el de DX-012 que congela un plan aceptado con firma también impide
-- que vuelva a PRESENTED o pase a REJECTED (aceptar una opción rechaza a sus
-- hermanas, nunca a la que se firmó).

CREATE TYPE "TreatmentPlanRejectionReason" AS ENUM ('PRICE', 'FEAR', 'SECOND_OPINION', 'OTHER_OPTION_ACCEPTED', 'OTHER');

ALTER TABLE "treatment_plans"
  ADD COLUMN "optionGroupId" UUID,
  ADD COLUMN "optionLabel" TEXT,
  ADD COLUMN "presentedAt" TIMESTAMP(3),
  ADD COLUMN "presentedLocationId" UUID,
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "rejectionReason" "TreatmentPlanRejectionReason",
  ADD COLUMN "rejectionNote" TEXT;

-- Coherencia de las columnas nuevas. Ninguna fila existente es PRESENTED ni
-- REJECTED ni tiene etiqueta, así que los CHECK no pueden fallar al crearse.
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_option_label_check"
  CHECK ("optionLabel" IS NULL OR length(btrim("optionLabel")) BETWEEN 1 AND 60);
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_presented_check"
  CHECK ("status" <> 'PRESENTED' OR ("presentedAt" IS NOT NULL AND "presentedLocationId" IS NOT NULL));
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_rejected_check"
  CHECK ("status" <> 'REJECTED' OR ("rejectedAt" IS NOT NULL AND "rejectionReason" IS NOT NULL));
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_rejection_note_check"
  CHECK (
    ("rejectionNote" IS NULL OR length("rejectionNote") <= 500)
    AND ("rejectionReason" IS DISTINCT FROM 'OTHER' OR length(btrim(coalesce("rejectionNote", ''))) > 0)
  );

CREATE INDEX "treatment_plans_tenantId_optionGroupId_patientId_idx" ON "treatment_plans"("tenantId", "optionGroupId", "patientId");
CREATE INDEX "treatment_plans_tenantId_status_presentedAt_idx" ON "treatment_plans"("tenantId", "status", "presentedAt");
CREATE INDEX "treatment_plans_tenantId_presentedLocationId_idx" ON "treatment_plans"("tenantId", "presentedLocationId");

-- FK COMPUESTAS por tenant (SEC-004): las FK se chequean saltando la RLS, así
-- que con una FK simple un plan de la clínica A podría entrar en un grupo de
-- la clínica B, o en el de otro paciente. MATCH SIMPLE: con optionGroupId (o
-- presentedLocationId) en NULL no se comprueba nada, que es lo que quieren los
-- planes sueltos. NO ACTION en el grupo: se comprueba al final de la sentencia,
-- así que un DELETE que se lleva el grupo entero de una vez pasa.
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_option_group_fkey"
  FOREIGN KEY ("tenantId", "optionGroupId", "patientId") REFERENCES "treatment_plans"("tenantId", "id", "patientId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_presented_location_fkey"
  FOREIGN KEY ("tenantId", "presentedLocationId") REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Plan aceptado con firma (DX-012): su moneda no cambia y no vuelve atrás
-- (borrador, presentado) ni pasa a rechazado. Cerrarlo (COMPLETED /
-- CANCELLED) y las notas, sí.
CREATE OR REPLACE FUNCTION "treatment_plans_locked_when_accepted"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."currency" IS DISTINCT FROM OLD."currency"
      OR (NEW."status" IN ('DRAFT', 'PRESENTED', 'REJECTED') AND NEW."status" IS DISTINCT FROM OLD."status")
      OR NEW."patientId" IS DISTINCT FROM OLD."patientId")
     AND EXISTS (SELECT 1 FROM "treatment_plan_acceptances" WHERE "planId" = OLD."id") THEN
    RAISE EXCEPTION 'el plan está aceptado y firmado: su moneda no cambia ni vuelve a borrador, a presentado ni a rechazado'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
