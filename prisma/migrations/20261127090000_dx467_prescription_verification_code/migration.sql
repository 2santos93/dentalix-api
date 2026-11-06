-- DX-467: código de verificación de la receta (expand; 1 de 5).
--
-- Cambios (aditivos; ninguna fila se reescribe aquí):
--   prescription_verification_code()  genera un código de 12 símbolos del
--       alfabeto sin ambiguos 23456789ABCDEFGHJKMNPQRSTUVWXYZ (sin 0/O, 1/I/L)
--       con bytes de gen_random_uuid() (pg_strong_random: CSPRNG). Usa solo
--       los 14 bytes aleatorios del UUID v4 (el 6 y el 8 llevan versión y
--       variante) y descarta los >= 248 (= 8 × 31), así b % 31 es uniforme.
--       Es el mismo alfabeto y largo que genera la API
--       (src/modules/prescriptions/domain/prescription-verification.ts).
--   prescriptions."verificationCode"  TEXT, NULL hasta el barrido
--       (20261126090200) y NOT NULL después (20261126090300). DEFAULT la
--       función: la API nueva escribe el suyo, pero una réplica anterior que
--       inserte sin nombrar la columna (despliegue escalonado) también deja
--       la receta con código. Cambiar el DEFAULT solo toca el catálogo.
--   prescriptions_verification_code_format_check  12 símbolos del alfabeto.
--   prescriptions_verification_code_present_check  sin NULL; tras el
--       barrido se valida y da paso al SET NOT NULL sin recorrer la tabla.
--       Los dos CHECK, NOT VALID aquí (no recorren la tabla) y validados en
--       20261126090300 (DB-029).
--   prescriptions_immutable  la receta sigue sin poder cambiar nada salvo
--       anularla, con UNA excepción: poner el código a una receta que aún no
--       lo tiene (NULL → código, nada más cambia). Es lo que hace el barrido;
--       tras el NOT NULL nunca hay un NULL, así que el código es inmutable.
--   audit_events_actor_check  la UNIÓN del de main (20261107160100, DX-443)
--       y la verificación pública de la receta (VIEW de PRESCRIPTION, origen
--       PUBLIC_LINK, sin actor, con uno de los tres motivos). NOT VALID; su
--       VALIDATE va en 20261126090400, en su propia transacción.
--
-- El código NO entra en el hash de la receta (identifica el documento, no es
-- lo prescrito): los hashes guardados siguen validando.
--
-- Índice único (tenantId, verificationCode), CONCURRENTLY en
-- 20261126090100: la búsqueda pública es por el código BAJO la RLS de la
-- clínica del host, y el índice por clínica es el que sirve a esa consulta.
-- Por clínica y no global: una colisión con otra clínica no puede ocurrir ni
-- servir de oráculo (un INSERT que fallase delataría que el código existe en
-- otra clínica), y la URL siempre se resuelve dentro de la clínica del host.
--
-- RLS: sin tabla nueva; prescriptions ya tiene ENABLE + FORCE y su política
-- tenant_isolation con NULLIF. Grants: no cambian (la función se ejecuta con
-- los permisos de quien inserta; EXECUTE es de PUBLIC por defecto).
--
-- Bloqueos: ADD COLUMN sin DEFAULT y SET DEFAULT solo tocan el catálogo; los
-- CHECK NOT VALID no recorren. ACCESS EXCLUSIVE de milisegundos.
-- Compatible hacia atrás: una réplica anterior no lee la columna y, al
-- insertar, recibe el DEFAULT. Vuelta atrás: DROP COLUMN "verificationCode",
-- DROP FUNCTION prescription_verification_code() y restaurar
-- prescriptions_immutable y el CHECK de auditoría de 20261107160100.

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public."prescription_verification_code"() RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  alphabet CONSTANT text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  code text := '';
  bytes bytea;
  b integer;
BEGIN
  WHILE length(code) < 12 LOOP
    bytes := uuid_send(gen_random_uuid());
    FOR i IN 0..15 LOOP
      CONTINUE WHEN i IN (6, 8);
      b := get_byte(bytes, i);
      CONTINUE WHEN b >= 248;
      code := code || substr(alphabet, (b % 31) + 1, 1);
      EXIT WHEN length(code) = 12;
    END LOOP;
  END LOOP;
  RETURN code;
END;
$$;

ALTER TABLE "prescriptions" ADD COLUMN "verificationCode" TEXT;
ALTER TABLE "prescriptions"
  ALTER COLUMN "verificationCode" SET DEFAULT public."prescription_verification_code"();
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_verification_code_format_check"
  CHECK ("verificationCode" ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{12}$') NOT VALID;
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_verification_code_present_check"
  CHECK ("verificationCode" IS NOT NULL) NOT VALID;

CREATE OR REPLACE FUNCTION public."prescriptions_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  void_columns CONSTANT text[] := ARRAY['status', 'voidedAt', 'voidedById', 'voidReason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
      RAISE EXCEPTION 'prescriptions es inmutable: una receta emitida no se borra'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  -- DX-467: poner el código a una receta que aún no lo tiene (el barrido).
  IF OLD."verificationCode" IS NULL AND NEW."verificationCode" IS NOT NULL
     AND (to_jsonb(NEW) - 'verificationCode') = (to_jsonb(OLD) - 'verificationCode') THEN
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'ISSUED' OR NEW."status" <> 'VOIDED'
     OR (to_jsonb(NEW) - void_columns) IS DISTINCT FROM (to_jsonb(OLD) - void_columns) THEN
    RAISE EXCEPTION 'prescriptions es inmutable: una receta emitida solo se puede anular'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actor_check";
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_check"
  CHECK (
    "actorUserId" IS NOT NULL
    OR "action" = 'LOGIN_FAILED'
    -- IS TRUE: un CHECK que da NULL PASA.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'PATIENT'
        AND "actorRole" IS NULL
        AND "resourceId" = "patientId"
        AND "metadata" ->> 'reason' = 'REMINDER_OPT_OUT'
        AND "metadata" ->> 'origin' IN ('LINK', 'MESSAGE')) IS TRUE
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'PAYMENT_PROMISE'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' IN ('PROMISE_KEPT', 'PROMISE_BROKEN')) IS TRUE
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'MEDICAL_HISTORY_SUBMISSION'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'LINK'
        AND "metadata" ->> 'reason' = 'ANAMNESIS_SUBMITTED') IS TRUE
    OR ("action" = 'CREATE'
        AND "resourceType" = 'DATA_CONSENT'
        AND "actorRole" IS NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'LINK'
        AND "metadata" ->> 'reason' = 'ANAMNESIS_LINK') IS TRUE
    -- DX-402: el barrido congeló una tasa de respaldo en un abono.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'PAYMENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' = 'EXCHANGE_RATE_BACKUP') IS TRUE
    -- DX-243: el paciente abre el enlace de firma, pide el código, lo
    -- verifica (o lo bloquea al fallar 5 veces) y firma.
    OR ("resourceType" = 'SIGNATURE_REQUEST'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'LINK'
        AND (("action" = 'VIEW' AND "metadata" ->> 'reason' = 'SIGNATURE_LINK_OPENED')
          OR ("action" = 'SEND' AND "metadata" ->> 'reason' = 'SIGNATURE_CODE_SENT')
          OR ("action" = 'UPDATE' AND "metadata" ->> 'reason' IN ('SIGNATURE_CODE_VERIFIED', 'SIGNATURE_LINK_LOCKED'))
          OR ("action" = 'SIGN' AND "metadata" ->> 'reason' = 'SIGNATURE_PATIENT_SIGNED'))) IS TRUE
    -- DX-361: el paciente confirma, cancela o pide que lo llamen desde el
    -- enlace de confirmación de la cita.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'APPOINTMENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'LINK'
        AND "metadata" ->> 'reason' IN ('CONFIRMATION_LINK_CONFIRMED',
                                        'CONFIRMATION_LINK_CANCELLED',
                                        'CONFIRMATION_LINK_CALL_REQUESTED')) IS TRUE
    -- DX-422: el trabajo del PDF firmado encontró un consentimiento cuyo
    -- hash no casa con lo guardado (no se archiva nada). Solo ids.
    OR ("action" = 'VIEW'
        AND "resourceType" = 'CONSENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' = 'SIGNED_PDF_INTEGRITY_MISMATCH') IS TRUE
    -- DX-435: el paciente acepta o rechaza la oferta de hueco desde el
    -- enlace, el enlace caduca o el hueco se lo queda otro paciente.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'WAITLIST_OFFER'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' IN ('SLOT_OFFER_ACCEPTED',
                                        'SLOT_OFFER_DECLINED',
                                        'SLOT_OFFER_EXPIRED',
                                        'SLOT_OFFER_TAKEN_BY_OTHER')) IS TRUE
    -- DX-435: la cita que crea (CREATE) o adelanta (UPDATE) la aceptación
    -- desde el enlace, con el paciente de la cita.
    OR ("action" IN ('CREATE', 'UPDATE')
        AND "resourceType" = 'APPOINTMENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' = 'SLOT_OFFER_ACCEPTED') IS TRUE
    -- DX-443: el paciente (o su responsable) descarga su copia del PDF
    -- firmado desde el enlace de un solo uso del email. Solo ids.
    OR ("action" = 'EXPORT'
        AND "resourceType" = 'CONSENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' = 'SIGNED_PDF_COPY_DOWNLOADED') IS TRUE
    -- DX-467: un tercero (la farmacia) verifica la receta con su código en
    -- la página pública: válida, anulada o con un hash que no casa. Solo ids.
    OR ("action" = 'VIEW'
        AND "resourceType" = 'PRESCRIPTION'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' IN ('PRESCRIPTION_VERIFIED',
                                        'PRESCRIPTION_VERIFIED_VOIDED',
                                        'PRESCRIPTION_INTEGRITY_MISMATCH')) IS TRUE
  ) NOT VALID;
