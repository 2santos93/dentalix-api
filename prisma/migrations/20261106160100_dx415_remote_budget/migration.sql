-- DX-415: aceptación del presupuesto a distancia por enlace con código
-- (porción 2 de DX-243).
--
-- Cambios:
--   signature_requests   `budgetContent` (JSONB) y `budgetContentHash`: la
--                     FOTO exacta del presupuesto que se envió (plan-quote.ts,
--                     la misma que firma la aceptación en la clínica, DX-012)
--                     y su SHA-256. Una solicitud BUDGET exige plan, foto y
--                     hash; una CONSENT no lleva ninguno (CHECK). El guard
--                     añade las dos columnas a las que nunca cambian.
--   treatment_plan_acceptances   la aceptación firmada a distancia se guarda
--                     aquí, como la de la clínica, con `signatureRequestId` y
--                     sus evidencias congeladas (canal, destino enmascarado,
--                     envío, apertura y verificación; IP y navegador ya
--                     existían). Todo o nada (CHECK); una solicitud produce
--                     como mucho una aceptación (índice único).
--
-- Reglas en la BD (la API responde antes en español; esto es la red): FK
-- COMPUESTA por tenant y paciente (SEC-004) de la aceptación a la solicitud.
-- La aceptación sigue siendo inmutable (trigger de DX-012).
--
-- Compatible hacia atrás: solo AÑADE columnas NULL sin DEFAULT (no reescribe
-- las tablas), un índice único, una FK y dos CHECK que las filas existentes
-- cumplen (ninguna solicitud es BUDGET: la API la rechazaba). El código
-- anterior no escribe ni lee las columnas nuevas.
--
-- Bloqueo: los ALTER toman ACCESS EXCLUSIVE hasta el COMMIT sin reescribir;
-- los VALIDATE recorren las tablas (pequeñas) sin bloquear más de lo
-- necesario. lock_timeout evita quedar encolado detrás de una transacción
-- larga.
--
-- Grants: columnas nuevas de tablas existentes; dentalix_app ya tiene los
-- privilegios de tabla.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. signature_requests: la foto del presupuesto enviado.
-- ---------------------------------------------------------------------------
ALTER TABLE "signature_requests"
  ADD COLUMN "budgetContent" JSONB,
  ADD COLUMN "budgetContentHash" TEXT;

ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_budget_check" CHECK (
  ("type" = 'BUDGET'
    AND "treatmentPlanId" IS NOT NULL
    AND jsonb_typeof("budgetContent") = 'object'
    AND "budgetContentHash" ~ '^[0-9a-f]{64}$')
  OR ("type" <> 'BUDGET'
    AND "budgetContent" IS NULL
    AND "budgetContentHash" IS NULL)
) NOT VALID;
ALTER TABLE "signature_requests" VALIDATE CONSTRAINT "signature_requests_budget_check";

-- La foto y su hash tampoco cambian nunca (mismo guard, dos líneas más).
CREATE OR REPLACE FUNCTION public."signature_requests_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD."signedAt" IS NOT NULL
     OR OLD."revokedAt" IS NOT NULL
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."channel" IS DISTINCT FROM OLD."channel"
     OR NEW."templateId" IS DISTINCT FROM OLD."templateId"
     OR NEW."templateVersion" IS DISTINCT FROM OLD."templateVersion"
     OR NEW."treatmentPlanId" IS DISTINCT FROM OLD."treatmentPlanId"
     OR NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."body" IS DISTINCT FROM OLD."body"
     OR NEW."professionalUserId" IS DISTINCT FROM OLD."professionalUserId"
     OR NEW."professionalName" IS DISTINCT FROM OLD."professionalName"
     OR NEW."signerType" IS DISTINCT FROM OLD."signerType"
     OR NEW."signerName" IS DISTINCT FROM OLD."signerName"
     OR NEW."signerDocument" IS DISTINCT FROM OLD."signerDocument"
     OR NEW."destination" IS DISTINCT FROM OLD."destination"
     OR NEW."destinationMasked" IS DISTINCT FROM OLD."destinationMasked"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."budgetContent" IS DISTINCT FROM OLD."budgetContent"
     OR NEW."budgetContentHash" IS DISTINCT FROM OLD."budgetContentHash"
     -- Las horas de la evidencia, una vez puestas, no se reescriben.
     OR (OLD."openedAt" IS NOT NULL AND NEW."openedAt" IS DISTINCT FROM OLD."openedAt")
     OR (OLD."verifiedAt" IS NOT NULL AND NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt")
     OR (OLD."lockedAt" IS NOT NULL AND NEW."lockedAt" IS DISTINCT FROM OLD."lockedAt") THEN
    RAISE EXCEPTION 'signature_requests: una solicitud firmada o anulada no cambia, ni su documento, destino o token (DX-243, DX-415)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. treatment_plan_acceptances: la aceptación a distancia y sus evidencias.
-- ---------------------------------------------------------------------------
ALTER TABLE "treatment_plan_acceptances"
  ADD COLUMN "signatureRequestId" UUID,
  ADD COLUMN "remoteChannel" "SignatureRequestChannel",
  ADD COLUMN "remoteDestinationMasked" TEXT,
  ADD COLUMN "remoteSentAt" TIMESTAMP(3),
  ADD COLUMN "remoteOpenedAt" TIMESTAMP(3),
  ADD COLUMN "remoteVerifiedAt" TIMESTAMP(3);

-- Una solicitud produce como mucho una aceptación; lado hijo de la FK (las
-- filas de la clínica llevan NULL y no chocan entre sí).
CREATE UNIQUE INDEX "treatment_plan_acceptances_signature_request_key"
  ON "treatment_plan_acceptances"("tenantId", "signatureRequestId", "patientId");

-- DX-134: con FORCE, el owner validaría la FK con la RLS (sin tenant no ve
-- filas). NO FORCE en la hija y en la referenciada mientras se valida (todas
-- las filas de la hija tienen `signatureRequestId` NULL) y FORCE de vuelta
-- en las dos al acabar.
ALTER TABLE "treatment_plan_acceptances" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "signature_requests" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_acceptances" ADD CONSTRAINT "treatment_plan_acceptances_signature_request_fkey"
  FOREIGN KEY ("tenantId", "signatureRequestId", "patientId")
  REFERENCES "signature_requests"("tenantId", "id", "patientId")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_signature_request_fkey";

-- En la clínica: ninguna evidencia remota. A distancia: todas.
ALTER TABLE "treatment_plan_acceptances" ADD CONSTRAINT "treatment_plan_acceptances_remote_check" CHECK (
  ("signatureRequestId" IS NULL
    AND "remoteChannel" IS NULL
    AND "remoteDestinationMasked" IS NULL
    AND "remoteSentAt" IS NULL
    AND "remoteOpenedAt" IS NULL
    AND "remoteVerifiedAt" IS NULL)
  OR ("signatureRequestId" IS NOT NULL
    AND "remoteChannel" IS NOT NULL
    AND char_length("remoteDestinationMasked") BETWEEN 1 AND 320
    AND "remoteSentAt" IS NOT NULL
    AND "remoteOpenedAt" IS NOT NULL
    AND "remoteVerifiedAt" IS NOT NULL)
) NOT VALID;
ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_remote_check";

ALTER TABLE "treatment_plan_acceptances" FORCE ROW LEVEL SECURITY;
ALTER TABLE "signature_requests" FORCE ROW LEVEL SECURITY;
