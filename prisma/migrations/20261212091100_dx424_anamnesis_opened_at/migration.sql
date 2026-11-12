-- DX-424: primera apertura del enlace de anamnesis por el paciente.
--
-- El GET público es de SOLO LECTURA (los previsualizadores de enlaces lo
-- abren solos); la apertura la avisa la página con
-- POST /public/medical-history/:token/opened, como las indicaciones
-- postoperatorias (DX-222). Sirve al reporte «Enlaces del paciente»:
-- abiertos y «caducados sin abrir».
--
-- Una vez puesta, `openedAt` no cambia (guard). Los envíos anteriores a esta
-- migración quedan con NULL: el reporte cuenta como abierto todo lo enviado.
ALTER TABLE "medical_history_submissions" ADD COLUMN "openedAt" TIMESTAMP(3);

-- La función del guard de DX-099 con una condición más: `openedAt` solo pasa
-- de NULL a una hora, nunca se reescribe ni se borra.
CREATE OR REPLACE FUNCTION public."medical_history_submissions_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD."status" IN ('ACCEPTED', 'REJECTED', 'EXPIRED')
     OR (OLD."answers" IS NOT NULL
         AND NEW."answers" IS DISTINCT FROM OLD."answers")
     OR (OLD."openedAt" IS NOT NULL
         AND NEW."openedAt" IS DISTINCT FROM OLD."openedAt")
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."appointmentId" IS DISTINCT FROM OLD."appointmentId"
     OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."questionnaireVersion" IS DISTINCT FROM OLD."questionnaireVersion"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'medical_history_submissions: un envío revisado o caducado no cambia, y sus respuestas no se reescriben (DX-099)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
