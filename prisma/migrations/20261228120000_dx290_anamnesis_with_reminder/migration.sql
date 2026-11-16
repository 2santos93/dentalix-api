-- DX-290: el recordatorio lleva el enlace de anamnesis si el paciente es
-- nuevo (sin anamnesis) o su anamnesis caducó (`tenants.anamnesisValidityMonths`,
-- DX-247) el día de la cita.
--
--   location_reminder_settings."sendAnamnesis"  ajuste por sede «Enviar la
--     anamnesis con el recordatorio» (por defecto apagado: nada cambia hasta
--     que el ADMIN lo enciende).
--   medical_history_submissions."origin"  STAFF (recepción, DX-099) o
--     REMINDER (el recordatorio automático, sin usuario): por eso
--     "createdById" admite NULL, y solo en los de origen REMINDER (CHECK).
--
-- Aditiva: columnas con DEFAULT constante (sin reescribir la tabla) y un
-- CHECK NOT VALID cuyo VALIDATE va en 20261228120200. lock_timeout evita
-- quedar encolado tras una transacción larga.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "MedicalHistorySubmissionOrigin" AS ENUM ('STAFF', 'REMINDER');

ALTER TABLE "location_reminder_settings"
  ADD COLUMN "sendAnamnesis" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "medical_history_submissions"
  ADD COLUMN "origin" "MedicalHistorySubmissionOrigin" NOT NULL DEFAULT 'STAFF';
ALTER TABLE "medical_history_submissions"
  ALTER COLUMN "createdById" DROP NOT NULL;
-- Con usuario ⇔ de recepción; el automático nunca lleva usuario.
ALTER TABLE "medical_history_submissions"
  ADD CONSTRAINT "medical_history_submissions_origin_creator_check"
  CHECK (("origin" = 'STAFF') = ("createdById" IS NOT NULL)) NOT VALID;

-- El guard de DX-099 (con la puerta de la fusión de DX-266 y `openedAt` de
-- DX-424) con una condición más: el origen es parte de la identidad del
-- envío y nunca cambia.
CREATE OR REPLACE FUNCTION public.medical_history_submissions_guard()
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
     OR NEW."origin" IS DISTINCT FROM OLD."origin"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'medical_history_submissions: un envío revisado o caducado no cambia, y sus respuestas no se reescriben (DX-099)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;
