-- DX-565: textos de los mensajes al paciente editables por la clínica.
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   message_templates   el asunto y el cuerpo que la clínica reescribió para
--                       un mensaje del catálogo en código (clave), un canal
--                       (EMAIL | WHATSAPP) y un idioma (es | en). UNIQUE
--                       (clínica, clave, canal, idioma). Sin fila = el texto
--                       por defecto del código. «Restablecer» borra la fila:
--                       es configuración sin datos de pacientes (no entra en
--                       dx_patient_merge_tables ni en la importación) y cada
--                       cambio queda en audit_events. Topes como los del
--                       código (asunto 150, cuerpo 2000) como red; el email
--                       lleva asunto y WhatsApp no.
--
-- FK directa a tenants con RESTRICT (DX-148) y a users (quién la guardó por
-- última vez), las dos DENTRO del CREATE TABLE (nace vacía: la validación no
-- lee filas, DX-134). RLS ENABLE + FORCE con la política NULLIF (DX-251).
--
-- Vuelta atrás: desplegar la API anterior y
--   DROP TABLE public."message_templates";
-- y se borra de `_prisma_migrations` la fila de esta migración. Los mensajes
-- vuelven al texto por defecto.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "message_templates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "message_templates_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "message_templates_updated_by_fkey"
      FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- La lista cerrada de claves vive en el código (MESSAGE_CATALOG): aquí,
    -- solo su forma, para añadir claves sin migración.
    CONSTRAINT "message_templates_key_check"
      CHECK ("key" ~ '^[a-z]+(-[a-z]+)*$' AND char_length("key") <= 64),
    CONSTRAINT "message_templates_channel_check"
      CHECK ("channel" IN ('EMAIL', 'WHATSAPP')),
    CONSTRAINT "message_templates_language_check"
      CHECK ("language" IN ('es', 'en')),
    CONSTRAINT "message_templates_subject_check" CHECK (
      ("channel" = 'EMAIL') = ("subject" IS NOT NULL)
      AND ("subject" IS NULL OR char_length("subject") BETWEEN 1 AND 150)
    ),
    CONSTRAINT "message_templates_body_check"
      CHECK (char_length("body") BETWEEN 1 AND 2000)
);

CREATE UNIQUE INDEX "message_templates_tenant_key_channel_language_key"
  ON "message_templates"("tenantId", "key", "channel", "language");
-- Lado hijo de la FK a users.
CREATE INDEX "message_templates_updated_by_idx" ON "message_templates"("updatedById");

ALTER TABLE "message_templates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "message_templates"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "message_templates" FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON "message_templates" TO dentalix_app;
REVOKE TRUNCATE ON "message_templates" FROM dentalix_app;
