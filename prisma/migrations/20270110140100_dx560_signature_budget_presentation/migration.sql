-- DX-560: la presentación del presupuesto al paciente, congelada al crear la
-- solicitud de aceptación a distancia (DX-415, también las del seguimiento
-- DX-561) y FUERA de lo sellado: la firma y su hash siguen cubriendo solo
-- "budgetContent".
--
--   signature_requests."budgetPresentation"   objeto jsonb o NULL:
--     { language, items: [{ index, visit, label }], visitOrganization,
--       secondCurrency?: { currency, fromPerBase, toPerBase, source, date } }
--     NULL en las solicitudes anteriores (la página pública cae a la lista
--     de siempre) y siempre en CONSENT.
--
-- Cambios (ADITIVOS):
--   - la columna, nullable y sin DEFAULT (solo toca el catálogo en PG 16);
--   - CHECK signature_requests_budget_presentation_check: NULL, o BUDGET con
--     un objeto de hasta 262144 bytes (holgado: 300 caracteres por ítem). NOT
--     VALID aquí; el VALIDATE va en 20270110140200 (sin bloquear escrituras);
--   - el guard de DX-243/DX-415/DX-561 con la columna nueva entre las que no
--     cambian tras crear la solicitud (misma definición que 20270107140100
--     más esa línea).
--
-- Vuelta atrás: desplegar la API anterior, recrear el guard con la definición
-- de 20270107140100 y
--   ALTER TABLE "signature_requests"
--     DROP CONSTRAINT "signature_requests_budget_presentation_check",
--     DROP COLUMN "budgetPresentation";

SET LOCAL lock_timeout = '5s';

ALTER TABLE "signature_requests"
  ADD COLUMN "budgetPresentation" JSONB;

ALTER TABLE "signature_requests"
  ADD CONSTRAINT "signature_requests_budget_presentation_check" CHECK (
    "budgetPresentation" IS NULL
    OR (
      "type" = 'BUDGET'
      AND jsonb_typeof("budgetPresentation") = 'object'
      AND pg_column_size("budgetPresentation") <= 262144
    )
  ) NOT VALID;

-- El guard (BEFORE UPDATE): la presentación tampoco cambia una vez creada.
CREATE OR REPLACE FUNCTION public.signature_requests_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
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
     OR NEW."budgetPresentation" IS DISTINCT FROM OLD."budgetPresentation"
     OR NEW."origin" IS DISTINCT FROM OLD."origin"
     -- Las horas de la evidencia, una vez puestas, no se reescriben.
     OR (OLD."openedAt" IS NOT NULL AND NEW."openedAt" IS DISTINCT FROM OLD."openedAt")
     OR (OLD."verifiedAt" IS NOT NULL AND NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt")
     OR (OLD."lockedAt" IS NOT NULL AND NEW."lockedAt" IS DISTINCT FROM OLD."lockedAt") THEN
    RAISE EXCEPTION 'signature_requests: una solicitud firmada o anulada no cambia, ni su documento, destino, token u origen (DX-243, DX-415, DX-561, DX-560)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;
