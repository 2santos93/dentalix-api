-- DX-101-bis: el paciente acepta el presupuesto con su firma desde el portal
-- (DX-101). La aceptación queda en treatment_plan_acceptances como la de la
-- clínica (DX-012) y la del enlace de firma (DX-415), con su propia evidencia:
-- el enlace de acceso de la sesión.
--
-- Cambios (ADITIVOS salvo el CHECK, que se redefine más permisivo; el código
-- anterior no lee ni escribe la columna nueva):
--   treatment_plan_acceptances."patientAccessLinkId"  UUID NULL, FK COMPUESTA
--       (tenantId, patientAccessLinkId, patientId) → patient_access_links: el
--       enlace de la MISMA clínica y del MISMO paciente (ON DELETE RESTRICT,
--       ON UPDATE CASCADE, como la de signature_requests). Índice del lado
--       hijo. La guarda de inmutabilidad de la tabla ya cubre la columna (no
--       enumera columnas).
--   patient_access_links  índice ÚNICO (tenantId, id, patientId), destino de
--       la FK (la tabla es pequeña y fría: un enlace por paciente compartido).
--   treatment_plan_acceptances_remote_check  se redefine: EN LA CLÍNICA
--       (ninguna evidencia), ENLACE DE FIRMA (la de DX-415, sin cambios) o
--       PORTAL (solo el enlace de acceso; nada del enlace de firma).
--
-- Sin canal nuevo en "SignatureRequestChannel": ese enum es también el canal
-- de signature_requests y de patient_consents; un PORTAL allí sería un valor
-- que ninguna solicitud de firma puede tener. La evidencia del portal es la
-- FK al enlace de acceso.
--
-- La FK y el CHECK van NOT VALID; su VALIDATE, en 20270115140100 (con NO
-- FORCE en las dos tablas, DX-134). dx_patient_merge_tables() no cambia: la
-- columna nueva no es un paciente (las dos tablas ya están en la lista por su
-- "patientId").
--
-- Vuelta atrás: desplegar la API anterior y
--   ALTER TABLE "treatment_plan_acceptances" DROP CONSTRAINT "treatment_plan_acceptances_remote_check";
--   (re)crear el CHECK de 20261106160100_dx415_remote_budget;
--   ALTER TABLE "treatment_plan_acceptances" DROP CONSTRAINT "treatment_plan_acceptances_patient_access_link_fkey";
--   DROP INDEX "treatment_plan_acceptances_patient_access_link_idx";
--   ALTER TABLE "treatment_plan_acceptances" DROP COLUMN "patientAccessLinkId";
--   DROP INDEX "patient_access_links_tenant_id_patient_key";

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plan_acceptances" ADD COLUMN "patientAccessLinkId" UUID;

CREATE UNIQUE INDEX "patient_access_links_tenant_id_patient_key"
  ON "patient_access_links"("tenantId", "id", "patientId");

-- Lado hijo de la FK (todas las filas existentes llevan NULL).
CREATE INDEX "treatment_plan_acceptances_patient_access_link_idx"
  ON "treatment_plan_acceptances"("tenantId", "patientAccessLinkId", "patientId");

ALTER TABLE "treatment_plan_acceptances" ADD CONSTRAINT "treatment_plan_acceptances_patient_access_link_fkey"
  FOREIGN KEY ("tenantId", "patientAccessLinkId", "patientId")
  REFERENCES "patient_access_links"("tenantId", "id", "patientId")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- En la clínica: ninguna evidencia. Por el enlace de firma (DX-415): todas
-- las suyas. Por el portal (DX-101-bis): solo el enlace de acceso.
ALTER TABLE "treatment_plan_acceptances" DROP CONSTRAINT "treatment_plan_acceptances_remote_check";
ALTER TABLE "treatment_plan_acceptances" ADD CONSTRAINT "treatment_plan_acceptances_remote_check" CHECK (
  ("signatureRequestId" IS NULL
    AND "remoteChannel" IS NULL
    AND "remoteDestinationMasked" IS NULL
    AND "remoteSentAt" IS NULL
    AND "remoteOpenedAt" IS NULL
    AND "remoteVerifiedAt" IS NULL
    AND "patientAccessLinkId" IS NULL)
  OR ("signatureRequestId" IS NOT NULL
    AND "remoteChannel" IS NOT NULL
    AND char_length("remoteDestinationMasked") BETWEEN 1 AND 320
    AND "remoteSentAt" IS NOT NULL
    AND "remoteOpenedAt" IS NOT NULL
    AND "remoteVerifiedAt" IS NOT NULL
    AND "patientAccessLinkId" IS NULL)
  OR ("patientAccessLinkId" IS NOT NULL
    AND "signatureRequestId" IS NULL
    AND "remoteChannel" IS NULL
    AND "remoteDestinationMasked" IS NULL
    AND "remoteSentAt" IS NULL
    AND "remoteOpenedAt" IS NULL
    AND "remoteVerifiedAt" IS NULL)
) NOT VALID;
