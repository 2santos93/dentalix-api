-- DX-085: registro de mensajes salientes al paciente, por clínica y por
-- canal (EMAIL, WHATSAPP_LINK, SMS). Lo escribirán los recordatorios de
-- DX-026 desde un trabajo de la cola (jobs) que corre bajo el tenant.
--
-- Relación con email_outbox (DX-088), sin duplicarlo: outbound_messages es el
-- registro de NEGOCIO (qué se le mandó a quién, por qué cita, con qué
-- plantilla, en qué quedó); email_outbox es el TRANSPORTE de email (mensaje
-- cifrado, arriendo y reintentos SMTP). Un mensaje EMAIL se entrega encolando
-- en email_outbox con "referenceId" = outbound_messages.id y queda QUEUED; su
-- entrega se lee de ahí. WHATSAPP_LINK y SMS no tienen transporte propio aún
-- (proveedores fuera de alcance: DX-026).
--
-- Datos personales: solo el destinatario ENMASCARADO ("an***@dominio",
-- "+57******4567"); el real se lee del paciente al enviar. "lastError" guarda
-- el tipo y el código del error, nunca su mensaje. Sin cuerpo del mensaje.
--
-- Compatible hacia atrás: solo AÑADE (dos enums y una tabla nueva con sus
-- FK, índices, CHECK y RLS). Las FK se declaran DENTRO del CREATE TABLE: la
-- tabla nace vacía, no hay nada que validar y no toca FORCE de appointments
-- (DX-113/DX-134). Funciona con un owner sin superusuario ni BYPASSRLS.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app.

CREATE TYPE "OutboundChannel" AS ENUM ('EMAIL', 'WHATSAPP_LINK', 'SMS');

CREATE TYPE "OutboundMessageStatus" AS ENUM ('PENDING', 'QUEUED', 'SENT', 'FAILED', 'CANCELLED');

CREATE TABLE "outbound_messages" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "channel" "OutboundChannel" NOT NULL,
    "template" TEXT NOT NULL,
    "recipientMasked" TEXT NOT NULL,
    "status" "OutboundMessageStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "appointmentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "outbound_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outbound_messages_template_check" CHECK ("template" ~ '^[a-z][a-z0-9-]{0,63}$'),
    -- Enmascarado: lleva *** y nunca es largo (ni una dirección completa).
    CONSTRAINT "outbound_messages_recipient_masked_check"
      CHECK (length("recipientMasked") BETWEEN 3 AND 120 AND position('***' IN "recipientMasked") > 0),
    CONSTRAINT "outbound_messages_attempts_check" CHECK ("attempts" BETWEEN 0 AND 25),
    CONSTRAINT "outbound_messages_last_error_check"
      CHECK ("lastError" IS NULL OR length("lastError") <= 200),
    CONSTRAINT "outbound_messages_sent_at_check"
      CHECK (("status" = 'SENT') = ("sentAt" IS NOT NULL)),
    CONSTRAINT "outbound_messages_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    -- FK COMPUESTA (SEC-004): la cita tiene que ser del MISMO tenant. CASCADE
    -- como appointment_confirmations: dato derivado de la cita, que en el
    -- producto nunca se borra en duro. MATCH SIMPLE: sin cita, no se evalúa.
    CONSTRAINT "outbound_messages_tenantId_appointmentId_fkey"
      FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "appointments"("tenantId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

-- Mensajes de una cita (¿ya se le recordó?) y lado hijo de la FK compuesta.
CREATE INDEX "outbound_messages_tenantId_appointmentId_createdAt_idx"
  ON "outbound_messages"("tenantId", "appointmentId", "createdAt" DESC);

-- Listado de la clínica por fecha (y lado hijo de la FK a tenants).
CREATE INDEX "outbound_messages_tenantId_createdAt_idx"
  ON "outbound_messages"("tenantId", "createdAt" DESC);

ALTER TABLE "outbound_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbound_messages" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "outbound_messages"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
