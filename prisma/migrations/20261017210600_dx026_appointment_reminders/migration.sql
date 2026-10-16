-- DX-026: recordatorio automático de cita por email, por sede.
--
-- Cambios:
--   location_reminder_settings  ajustes de recordatorio de cada sede: activo
--                               (por defecto NO) y hasta 3 antelaciones en
--                               horas (1..168). Una fila por sede; sin fila =
--                               desactivado.
--   appointment_reminders       registro de cada recordatorio de una cita por
--                               (antelación, hora de inicio): enviado (con el
--                               id de su outbound_messages, nunca el cuerpo),
--                               omitido (con el motivo) o enviándose. El
--                               índice único es la red de idempotencia del
--                               handler, además de la idempotencyKey del
--                               trabajo (jobs).
--   outbound_messages           UNIQUE ("tenantId", "id"): destino de la FK
--                               compuesta del registro (SEC-004).
--
-- Compatible hacia atrás: solo AÑADE (dos enums, dos tablas nuevas con sus
-- FK, CHECK, índices y RLS, y un índice único en outbound_messages que no
-- puede fallar porque "id" ya es la PK). Las FK se declaran DENTRO del CREATE
-- TABLE: las tablas nacen vacías, no hay nada que validar y no se toca FORCE
-- de locations, appointments ni outbound_messages (DX-113/DX-134). Funciona
-- con un owner sin superusuario ni BYPASSRLS.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

CREATE TYPE "AppointmentReminderStatus" AS ENUM ('SENDING', 'SENT', 'SKIPPED');

CREATE TYPE "AppointmentReminderSkipReason" AS ENUM (
  'NO_EMAIL', 'CANCELLED', 'COMPLETED', 'NO_SHOW', 'RESCHEDULED', 'DELETED',
  'DISABLED', 'TOO_LATE'
);

-- Destino de la FK compuesta de appointment_reminders.
CREATE UNIQUE INDEX "outbound_messages_tenant_id_key"
  ON "outbound_messages"("tenantId", "id");

-- ---------------------------------------------------------------------------
-- location_reminder_settings
-- ---------------------------------------------------------------------------
CREATE TABLE "location_reminder_settings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "leadHours" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_reminder_settings_pkey" PRIMARY KEY ("id"),
    -- La API responde 400 en español antes; esto es la red: una lista plana de
    -- como mucho 3 antelaciones entre 1 h y 7 días, y activo exige al menos una.
    CONSTRAINT "location_reminder_settings_lead_hours_check"
      CHECK (
        cardinality("leadHours") <= 3
        AND (cardinality("leadHours") = 0 OR array_ndims("leadHours") = 1)
        AND array_position("leadHours", NULL) IS NULL
        AND 1 <= ALL ("leadHours")
        AND 168 >= ALL ("leadHours")
      ),
    CONSTRAINT "location_reminder_settings_enabled_check"
      CHECK (NOT "enabled" OR cardinality("leadHours") >= 1),
    CONSTRAINT "location_reminder_settings_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    -- FK COMPUESTA (SEC-004): la sede tiene que ser del MISMO tenant. CASCADE:
    -- es configuración de la sede, que en el producto se retira en blando.
    CONSTRAINT "location_reminder_settings_tenantId_locationId_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

-- Una fila por sede; también es el lado hijo de la FK compuesta y sirve el
-- barrido por clínica ("tenantId" = $1 AND "enabled").
CREATE UNIQUE INDEX "location_reminder_settings_tenant_location_key"
  ON "location_reminder_settings"("tenantId", "locationId");

ALTER TABLE "location_reminder_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "location_reminder_settings" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "location_reminder_settings"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- appointment_reminders
-- ---------------------------------------------------------------------------
CREATE TABLE "appointment_reminders" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "leadHours" INTEGER NOT NULL,
    "appointmentStart" TIMESTAMP(3) NOT NULL,
    "status" "AppointmentReminderStatus" NOT NULL DEFAULT 'SENDING',
    "skipReason" "AppointmentReminderSkipReason",
    "outboundMessageId" UUID,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointment_reminders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "appointment_reminders_lead_hours_check"
      CHECK ("leadHours" BETWEEN 1 AND 168),
    CONSTRAINT "appointment_reminders_skip_reason_check"
      CHECK (("status" = 'SKIPPED') = ("skipReason" IS NOT NULL)),
    CONSTRAINT "appointment_reminders_sent_check"
      CHECK (("status" = 'SENT') = ("sentAt" IS NOT NULL)
             AND ("status" <> 'SENT' OR "outboundMessageId" IS NOT NULL)),
    CONSTRAINT "appointment_reminders_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    -- FK COMPUESTA (SEC-004). CASCADE como outbound_messages: dato derivado de
    -- la cita, que en el producto nunca se borra en duro.
    CONSTRAINT "appointment_reminders_tenantId_appointmentId_fkey"
      FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "appointments"("tenantId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    -- FK COMPUESTA al mensaje del registro de salientes (DX-085), del MISMO
    -- tenant. MATCH SIMPLE: sin mensaje (omitido), no se evalúa.
    CONSTRAINT "appointment_reminders_tenantId_outboundMessageId_fkey"
      FOREIGN KEY ("tenantId", "outboundMessageId") REFERENCES "outbound_messages"("tenantId", "id")
      ON DELETE NO ACTION ON UPDATE CASCADE
);

-- Un recordatorio por (cita, antelación, hora de inicio): el reclamo del
-- handler (INSERT … ON CONFLICT DO NOTHING) y la lectura del estado de la
-- cita; también es el lado hijo de la FK compuesta a appointments.
CREATE UNIQUE INDEX "appointment_reminders_tenant_appointment_lead_start_key"
  ON "appointment_reminders"("tenantId", "appointmentId", "leadHours", "appointmentStart");

-- Lado hijo de la FK compuesta a outbound_messages.
CREATE INDEX "appointment_reminders_tenant_outbound_idx"
  ON "appointment_reminders"("tenantId", "outboundMessageId")
  WHERE "outboundMessageId" IS NOT NULL;

ALTER TABLE "appointment_reminders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_reminders" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "appointment_reminders"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
