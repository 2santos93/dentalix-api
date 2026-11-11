-- DX-342: paso a la mayoría de edad de un paciente con responsable.
--
--   MajorityReviewDecision     enum nuevo: PATIENT_SELF (los envíos van al
--                              propio paciente) o KEEP_RESPONSIBLE (el
--                              paciente consiente; vuelve la regla de DX-203).
--   patient_majority_reviews   una fila por revisión: quién («reviewedById»,
--                              puntero suave a users), cuándo, la decisión, una
--                              nota libre (≤ 500, nunca en la auditoría) y la
--                              fecha de mayoría de edad revisada. Rige la
--                              última y solo para esa fecha: si cambia la fecha
--                              de nacimiento o la mayoría de edad de la
--                              clínica, el paciente vuelve a estar pendiente.
--
-- Solo AÑADE (un enum y una tabla vacía): el código anterior no la conoce.
-- La FK COMPUESTA por clínica (SEC-004) va dentro del CREATE TABLE (la tabla
-- nace vacía: nada que validar con FORCE, DX-134). RLS FORCE por clínica,
-- como patient_responsible_parties. Registro de evidencia: la app inserta y
-- lee; nunca cambia ni borra (privilegios como treatment_plan_repricings).
--
-- Vuelta atrás: desplegar la API anterior y
--   DROP TABLE public."patient_majority_reviews";
--   DROP TYPE public."MajorityReviewDecision";
-- (se pierden las revisiones: los pacientes vuelven a PENDIENTE).

SET LOCAL lock_timeout = '5s';

CREATE TYPE "MajorityReviewDecision" AS ENUM ('PATIENT_SELF', 'KEEP_RESPONSIBLE');

CREATE TABLE "patient_majority_reviews" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "decision" "MajorityReviewDecision" NOT NULL,
    "note" TEXT,
    "majorityDate" DATE NOT NULL,
    "reviewedById" UUID NOT NULL,
    "reviewedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_majority_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_majority_reviews_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_majority_reviews_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Mismo tope que la API; una nota en blanco se guarda como NULL.
    CONSTRAINT "patient_majority_reviews_note_check" CHECK (
      "note" IS NULL OR char_length(btrim("note")) BETWEEN 1 AND 500
    )
);

-- La última revisión de un paciente (y lado hijo de la FK compuesta).
CREATE INDEX "patient_majority_reviews_patient_idx"
  ON "patient_majority_reviews"("tenantId", "patientId", "reviewedAt" DESC);

ALTER TABLE "patient_majority_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_majority_reviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_majority_reviews"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT ON "patient_majority_reviews" TO dentalix_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "patient_majority_reviews" FROM dentalix_app;
