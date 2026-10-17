-- DX-128: preferencia de canal y baja de los recordatorios del paciente.
--
-- Cambios:
--   ContactChannel, WhatsappOptInSource, ReminderOptOutSource   enums nuevos.
--   tenants."defaultContactChannel"   canal con el que nace cada paciente de
--                                     la clínica (EMAIL, el único automático
--                                     que existe hoy: DX-026).
--   patients   canal (por defecto EMAIL), opt-in de WhatsApp (fecha, origen y
--              quién lo registró) y baja de recordatorios (fecha y origen),
--              con CHECK de que fecha y origen van juntos.
--   reminder_opt_out_links   enlace de baja de cada email de recordatorio
--                            (hash del token), con RLS FORCE y FK compuesta.
--   AppointmentReminderSkipReason   + OPTED_OUT, CHANNEL_NONE,
--                                   CHANNEL_WHATSAPP (no se usan en esta
--                                   migración: ADD VALUE va en transacción).
--   audit_events_actor_check   admite actor NULL también en la baja que hace
--                              el propio paciente (enlace o mensaje), que no
--                              es un usuario de la clínica.
--   dx_phone_tail(text) + índice parcial   para encontrar los pacientes de un
--                              móvil que respondió «BAJA» (DX-126).
--
-- Datos: los pacientes existentes quedan con el canal por defecto de SU
-- clínica, sin opt-in de WhatsApp y sin baja. "phone" no se toca (el botón
-- wa.me manual de DX-005 sigue igual).
--
-- Compatible hacia atrás: solo AÑADE columnas con DEFAULT constante (sin
-- reescribir la tabla en PG ≥ 11), una tabla vacía, valores de enum y un
-- CHECK de auditoría MÁS PERMISIVO que el anterior (NOT VALID + VALIDATE: no
-- bloquea las escrituras mientras se comprueba). El código anterior no lee ni
-- escribe las columnas nuevas y sus INSERT toman los DEFAULT.
--
-- row_security = off: con RLS FORCE el owner sin BYPASSRLS vería 0 pacientes
-- y el backfill no haría nada en silencio (ver 20261016130000_domain_checks).

SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';

CREATE TYPE "ContactChannel" AS ENUM ('EMAIL', 'WHATSAPP', 'NONE');
CREATE TYPE "WhatsappOptInSource" AS ENUM ('IN_PERSON', 'LINK', 'MESSAGE');
CREATE TYPE "ReminderOptOutSource" AS ENUM ('LINK', 'MESSAGE', 'STAFF');

ALTER TYPE "AppointmentReminderSkipReason" ADD VALUE 'OPTED_OUT';
ALTER TYPE "AppointmentReminderSkipReason" ADD VALUE 'CHANNEL_NONE';
ALTER TYPE "AppointmentReminderSkipReason" ADD VALUE 'CHANNEL_WHATSAPP';

-- ---------------------------------------------------------------------------
-- Canal por defecto de la clínica y del paciente
-- ---------------------------------------------------------------------------
ALTER TABLE "tenants"
  ADD COLUMN "defaultContactChannel" "ContactChannel" NOT NULL DEFAULT 'EMAIL';

ALTER TABLE "patients"
  ADD COLUMN "contactChannel" "ContactChannel" NOT NULL DEFAULT 'EMAIL',
  ADD COLUMN "whatsappOptInAt" TIMESTAMP(3),
  ADD COLUMN "whatsappOptInSource" "WhatsappOptInSource",
  ADD COLUMN "whatsappOptInById" UUID,
  ADD COLUMN "reminderOptOutAt" TIMESTAMP(3),
  ADD COLUMN "reminderOptOutSource" "ReminderOptOutSource",
  ADD CONSTRAINT "patients_whatsapp_opt_in_check"
    CHECK (("whatsappOptInAt" IS NULL) = ("whatsappOptInSource" IS NULL)
           AND ("whatsappOptInById" IS NULL OR "whatsappOptInAt" IS NOT NULL)),
  ADD CONSTRAINT "patients_reminder_opt_out_check"
    CHECK (("reminderOptOutAt" IS NULL) = ("reminderOptOutSource" IS NULL));

-- Cada paciente existente, con el canal por defecto de su clínica. Hoy todas
-- nacen con EMAIL, así que en un despliegue normal no cambia ninguna fila; la
-- sentencia deja la regla escrita y es idempotente.
-- DX-113: con un owner sin superusuario ni BYPASSRLS, FORCE lo sujeta a la RLS
-- y, con row_security = off, esta sentencia fallaría. Se quita FORCE solo
-- durante el backfill, en esta misma transacción, y se restaura justo después.
ALTER TABLE "patients" NO FORCE ROW LEVEL SECURITY;
UPDATE "patients" p
   SET "contactChannel" = t."defaultContactChannel"
  FROM "tenants" t
 WHERE t."id" = p."tenantId"
   AND p."contactChannel" IS DISTINCT FROM t."defaultContactChannel";
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Móvil → pacientes (respuesta «BAJA» por WhatsApp, DX-126)
-- Últimos 8 dígitos del teléfono tal como se escribió: sirve de prefiltro
-- indexado; la API compara después el E.164 completo. SQL de una sentencia,
-- IMMUTABLE y sin SET para que el planner la inline en el índice.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_phone_tail(phone text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT pg_catalog.right(pg_catalog.regexp_replace(phone, '[^0-9]', '', 'g'), 8)
$$;

CREATE INDEX "patients_tenant_phone_tail_live_idx"
  ON "patients" ("tenantId", public.dx_phone_tail("phone"))
  WHERE "deletedAt" IS NULL AND "phone" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- reminder_opt_out_links
-- ---------------------------------------------------------------------------
CREATE TABLE "reminder_opt_out_links" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "reminder_opt_out_links_pkey" PRIMARY KEY ("id"),
    -- SHA-256 en hex: nunca el token en claro.
    CONSTRAINT "reminder_opt_out_links_token_hash_check"
      CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "reminder_opt_out_links_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    -- FK COMPUESTA (SEC-004). CASCADE: el enlace no tiene sentido sin su
    -- paciente, que en el producto solo se retira en blando.
    CONSTRAINT "reminder_opt_out_links_tenantId_patientId_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

-- Búsqueda del enlace público por el hash del token.
CREATE UNIQUE INDEX "reminder_opt_out_links_tokenHash_key"
  ON "reminder_opt_out_links"("tokenHash");
-- Lado hijo de la FK compuesta (y los enlaces de un paciente).
CREATE INDEX "reminder_opt_out_links_tenantId_patientId_idx"
  ON "reminder_opt_out_links"("tenantId", "patientId");

ALTER TABLE "reminder_opt_out_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reminder_opt_out_links" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "reminder_opt_out_links"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- Auditoría: la baja que hace el propio paciente no tiene usuario de la
-- clínica. Solo esa escritura concreta (UPDATE de PATIENT con el motivo
-- REMINDER_OPT_OUT) puede ir sin actor, además del login fallido.
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actor_check";
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_check"
  CHECK (
    "actorUserId" IS NOT NULL
    OR "action" = 'LOGIN_FAILED'
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'PATIENT'
        AND "metadata" ->> 'reason' = 'REMINDER_OPT_OUT')
  ) NOT VALID;
ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";
