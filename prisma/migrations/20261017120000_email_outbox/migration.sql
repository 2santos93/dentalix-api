-- DX-088: email transaccional. Registro de envíos (patrón outbox) que el
-- despachador en proceso de la API lee y marca.
--
-- Compatible hacia atrás: solo AÑADE (dos enums, una tabla con sus índices,
-- su política RLS y tres funciones). No toca ninguna tabla existente.
--
-- Datos personales: la tabla NUNCA guarda el email ni el token en claro.
--   toHash    HMAC-SHA256 del email normalizado (clave derivada de
--             MAIL_ENCRYPTION_KEY): permite agrupar envíos al mismo destino
--             sin poder revertirlo con un diccionario de emails.
--   toMasked  "ma***@dominio" para soporte.
--   payload   el mensaje ya renderizado (destinatario, asunto, html, texto)
--             cifrado con AES-256-GCM; se borra al quedar SENT o FAILED
--             (lo garantiza el CHECK de abajo, no solo el código).
--   lastError tipo de error y código del proveedor, nunca su mensaje.
--
-- RLS y tenant opcional: la tabla lleva la política estándar de las tablas de
-- clínica (rls-catalog.int-spec.ts), así que desde una petición solo se ven y
-- se escriben las filas de la clínica en contexto, y una fila con
-- "tenantId" NULL (email de plataforma) no la ve nadie por esa vía. El
-- despachador tiene que reclamar filas de TODAS las clínicas y las de
-- plataforma: lo hace por tres funciones SECURITY DEFINER (el bypass
-- controlado en un único punto que propone AUDITORIA-BD DB-004), propiedad
-- del owner de las migraciones, que debe saltarse la RLS (superusuario o
-- BYPASSRLS, el mismo requisito que DX-025). Llevan `SET row_security = off`:
-- si el owner NO la saltara, fallan con "query would be affected by
-- row-level security policy" en vez de devolver 0 filas en silencio.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en la tabla. Las
-- funciones se retiran de PUBLIC y se conceden explícitamente a dentalix_app.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "EmailOutboxStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

CREATE TYPE "EmailTemplate" AS ENUM ('invitation', 'password-reset', 'email-verify', 'appointment-reminder');

-- ---------------------------------------------------------------------------
-- 2. Tabla
-- ---------------------------------------------------------------------------
CREATE TABLE "email_outbox" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "template" "EmailTemplate" NOT NULL,
    "toHash" TEXT NOT NULL,
    "toMasked" TEXT NOT NULL,
    "referenceId" UUID,
    "payload" BYTEA,
    "status" "EmailOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id"),
    -- Al terminar (bien o mal) no queda nada que descifrar.
    CONSTRAINT "email_outbox_payload_cleared_check"
      CHECK ("status" NOT IN ('SENT', 'FAILED') OR "payload" IS NULL),
    -- Mientras quede por enviar, hay mensaje que enviar.
    CONSTRAINT "email_outbox_payload_present_check"
      CHECK ("status" NOT IN ('PENDING', 'SENDING') OR "payload" IS NOT NULL),
    CONSTRAINT "email_outbox_attempts_check" CHECK ("attempts" BETWEEN 0 AND 20),
    CONSTRAINT "email_outbox_last_error_check"
      CHECK ("lastError" IS NULL OR length("lastError") <= 200),
    CONSTRAINT "email_outbox_to_hash_check" CHECK ("toHash" ~ '^[0-9a-f]{64}$')
);

-- ---------------------------------------------------------------------------
-- 3. Índices
-- ---------------------------------------------------------------------------
-- El barrido del despachador: PENDING (o SENDING con el arriendo vencido) cuya
-- hora ya llegó, en orden de vencimiento.
CREATE INDEX "email_outbox_status_nextAttemptAt_idx" ON "email_outbox"("status", "nextAttemptAt");

-- Estado de envío de una invitación en el directorio de personal (el último
-- envío de cada referencia) y cancelar los pendientes al reenviar o revocar.
-- Indexa además el lado hijo de la FK a tenants.
CREATE INDEX "email_outbox_tenantId_referenceId_createdAt_idx" ON "email_outbox"("tenantId", "referenceId", "createdAt" DESC);

-- Topes anti-abuso (DX-088, revisión B1): envíos al mismo destinatario en la
-- clínica (enfriamiento y máximo diario) y envíos de la clínica en el día.
CREATE INDEX "email_outbox_tenantId_toHash_createdAt_idx" ON "email_outbox"("tenantId", "toHash", "createdAt" DESC);
CREATE INDEX "email_outbox_tenantId_createdAt_idx" ON "email_outbox"("tenantId", "createdAt" DESC);

-- CASCADE a propósito (como appointment_confirmations): el registro es dato
-- derivado de la clínica y los tenants nunca se borran en duro en el producto;
-- así una limpieza administrativa no queda bloqueada por envíos.
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. RLS (mismo predicado que el resto de tablas de clínica, DX-068)
-- ---------------------------------------------------------------------------
ALTER TABLE "email_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_outbox" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "email_outbox"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- 5. Funciones del despachador (SECURITY DEFINER, ver la cabecera)
-- ---------------------------------------------------------------------------

-- Reclama hasta p_limit envíos vencidos de cualquier clínica: los pasa a
-- SENDING, suma un intento y les da un arriendo de p_lease_seconds (acotado a
-- [1, 900] s: nadie puede "aparcar" filas durante años). Un
-- SENDING cuyo arriendo venció (la réplica murió a mitad) vuelve a ser
-- reclamable. FOR UPDATE SKIP LOCKED: dos réplicas nunca reclaman la misma
-- fila ni se esperan entre sí.
-- DX-113: con un owner sin superusuario ni BYPASSRLS, FORCE lo sujeta a la RLS
-- y la validación del cuerpo de estas funciones (que corre con su
-- `row_security = off`) falla al crearlas. Se quita FORCE solo mientras se
-- crean, en esta misma transacción, y se restaura justo después: el
-- resultado es el mismo. Cómo leen la tabla sin saltarse la RLS lo resuelve
-- 20261017180000_dx113_email_outbox_dispatcher_role.
ALTER TABLE "email_outbox" NO FORCE ROW LEVEL SECURITY;

CREATE FUNCTION email_outbox_claim(p_limit integer, p_lease_seconds integer)
RETURNS TABLE ("id" uuid, "tenantId" uuid, "payload" bytea, "attempts" integer)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
  UPDATE "email_outbox" AS o
     SET "status" = 'SENDING',
         "attempts" = o."attempts" + 1,
         "nextAttemptAt" = timezone('utc', now())
                           + make_interval(secs => least(greatest(p_lease_seconds, 1), 900)),
         "updatedAt" = timezone('utc', now())
   WHERE o."id" IN (
     SELECT c."id"
       FROM "email_outbox" AS c
      WHERE c."status" IN ('PENDING', 'SENDING')
        AND c."nextAttemptAt" <= timezone('utc', now())
      ORDER BY c."nextAttemptAt"
      LIMIT least(greatest(p_limit, 1), 100)
      FOR UPDATE SKIP LOCKED
   )
  RETURNING o."id", o."tenantId", o."payload", o."attempts";
$$;

-- Cierra un intento reclamado: SENT, FAILED (definitivo) o de vuelta a
-- PENDING con su próximo intento. Solo actúa sobre una fila en SENDING Y en
-- el MISMO intento que se reclamó (p_attempts, "fencing"): si el arriendo
-- venció y otra réplica la reclamó de nuevo, el cierre tardío del primero no
-- pisa el del segundo. Al terminar borra el mensaje cifrado. Devuelve si cerró
-- algo.
CREATE FUNCTION email_outbox_settle(
  p_id uuid,
  p_attempts integer,
  p_status "EmailOutboxStatus",
  p_next_attempt_at timestamp(3),
  p_last_error text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  affected integer;
BEGIN
  IF p_status NOT IN ('SENT', 'FAILED', 'PENDING') THEN
    RAISE EXCEPTION 'email_outbox_settle: estado no permitido %', p_status;
  END IF;
  IF p_status = 'PENDING' AND p_next_attempt_at IS NULL THEN
    RAISE EXCEPTION 'email_outbox_settle: PENDING exige p_next_attempt_at';
  END IF;

  UPDATE "email_outbox"
     SET "status" = p_status,
         "lastError" = left(p_last_error, 200),
         "nextAttemptAt" = coalesce(p_next_attempt_at, "nextAttemptAt"),
         "sentAt" = CASE WHEN p_status = 'SENT' THEN timezone('utc', now()) ELSE "sentAt" END,
         "payload" = CASE WHEN p_status IN ('SENT', 'FAILED') THEN NULL ELSE "payload" END,
         "updatedAt" = timezone('utc', now())
   WHERE "id" = p_id AND "status" = 'SENDING' AND "attempts" = p_attempts;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

-- Encola un email de PLATAFORMA (sin clínica). "tenantId" queda NULL por
-- construcción: esta vía no puede escribir en una clínica. Los de clínica se
-- insertan por la tabla, bajo su RLS.
CREATE FUNCTION email_outbox_enqueue_platform(
  p_template "EmailTemplate",
  p_to_hash text,
  p_to_masked text,
  p_payload bytea,
  p_reference_id uuid
)
RETURNS uuid
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
  INSERT INTO "email_outbox"
    ("id", "tenantId", "template", "toHash", "toMasked", "referenceId",
     "payload", "status", "attempts", "nextAttemptAt", "createdAt", "updatedAt")
  VALUES
    (gen_random_uuid(), NULL, p_template, p_to_hash, p_to_masked, p_reference_id,
     p_payload, 'PENDING', 0, timezone('utc', now()), timezone('utc', now()),
     timezone('utc', now()))
  RETURNING "id";
$$;

ALTER TABLE "email_outbox" FORCE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION email_outbox_claim(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION email_outbox_settle(uuid, integer, "EmailOutboxStatus", timestamp(3), text) FROM PUBLIC;
REVOKE ALL ON FUNCTION email_outbox_enqueue_platform("EmailTemplate", text, text, bytea, uuid) FROM PUBLIC;

-- GRANT explícito al rol de la app (revisión M3), no a "quien pueda escribir
-- en X": un rol futuro (soporte, analítica) no lo hereda en silencio. En una
-- BD cuyo rol de la app tenga otro nombre, concede EXECUTE a mano (README).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    GRANT EXECUTE ON FUNCTION email_outbox_claim(integer, integer) TO dentalix_app;
    GRANT EXECUTE ON FUNCTION email_outbox_settle(uuid, integer, "EmailOutboxStatus", timestamp(3), text) TO dentalix_app;
    GRANT EXECUTE ON FUNCTION email_outbox_enqueue_platform("EmailTemplate", text, text, bytea, uuid) TO dentalix_app;
  END IF;
END;
$$;
