-- DX-203: responsable de pago y de los avisos de un paciente.
--
-- Cambios:
--   ResponsibleRelationship, OutboundRecipientKind   enums nuevos.
--   patient_responsible_parties   el responsable de un paciente: OTRO paciente
--                      de la clínica ("responsiblePatientId") o un contacto
--                      sin ficha (nombre, tipo y nº de documento, email,
--                      teléfono), con parentesco, pagador principal
--                      ("isPayer") y si recibe los avisos ("receivesNotices").
--                      Se quita en blando ("deletedAt").
--   outbound_messages."recipientKind"   el registro de envíos dice si el
--                      mensaje fue al paciente o a su responsable (DEFAULT
--                      constante: sin reescribir la tabla).
--
-- Reglas en la BD (la API responde antes en español; esto es la red):
--   - una sola forma: paciente responsable (sin datos de contacto propios) o
--     contacto con nombre;
--   - nadie es su propio responsable;
--   - como mucho UN pagador principal vivo por paciente y el mismo paciente
--     responsable una sola vez (índices únicos parciales).
--
-- FK COMPUESTAS por tenant (SEC-004): paciente y responsable de la MISMA
-- clínica. Van DENTRO del CREATE TABLE (la tabla nace vacía), así el owner sin
-- BYPASSRLS no necesita ver filas de patients (DX-134).
--
-- Compatible hacia atrás: solo AÑADE (dos enums, una tabla vacía, una columna
-- con DEFAULT, índices y RLS). El código anterior no las conoce; sus INSERT en
-- outbound_messages toman el DEFAULT. La copia de guardianName/
-- guardianDocNumber va en la migración siguiente (idempotente).
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "ResponsibleRelationship" AS ENUM ('MOTHER', 'FATHER', 'LEGAL_GUARDIAN', 'GRANDPARENT', 'SIBLING', 'SPOUSE', 'CHILD', 'OTHER');
CREATE TYPE "OutboundRecipientKind" AS ENUM ('PATIENT', 'RESPONSIBLE');

ALTER TABLE "outbound_messages"
  ADD COLUMN "recipientKind" "OutboundRecipientKind" NOT NULL DEFAULT 'PATIENT';

CREATE TABLE "patient_responsible_parties" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "responsiblePatientId" UUID,
    "fullName" TEXT,
    "docType" "DocType",
    "docNumber" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "relationship" "ResponsibleRelationship" NOT NULL,
    "isPayer" BOOLEAN NOT NULL DEFAULT false,
    "receivesNotices" BOOLEAN NOT NULL DEFAULT true,
    "migratedFromGuardian" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "patient_responsible_parties_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_responsible_parties_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTAS: el paciente y su responsable son de la MISMA clínica.
    CONSTRAINT "patient_responsible_parties_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_responsible_parties_responsible_fkey"
      FOREIGN KEY ("tenantId", "responsiblePatientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Paciente responsable (sus datos salen de su ficha) o contacto con nombre.
    CONSTRAINT "patient_responsible_parties_kind_check" CHECK (
      ("responsiblePatientId" IS NOT NULL
        AND "fullName" IS NULL AND "docType" IS NULL AND "docNumber" IS NULL
        AND "email" IS NULL AND "phone" IS NULL)
      OR ("responsiblePatientId" IS NULL
        AND char_length(btrim("fullName")) BETWEEN 1 AND 200)
    ),
    CONSTRAINT "patient_responsible_parties_not_self_check"
      CHECK ("responsiblePatientId" IS DISTINCT FROM "patientId"),
    -- Mismos topes que la API.
    CONSTRAINT "patient_responsible_parties_lengths_check" CHECK (
      ("docNumber" IS NULL OR char_length("docNumber") <= 60)
      AND ("email" IS NULL OR char_length("email") <= 254)
      AND ("phone" IS NULL OR char_length("phone") <= 40)
    )
);

-- Responsables de un paciente (ficha, avisos, estado de cuenta).
CREATE INDEX "patient_responsible_parties_tenant_patient_idx"
  ON "patient_responsible_parties"("tenantId", "patientId", "createdAt");
-- «Responsable de: …» y estado de cuenta familiar del pagador; también el lado
-- hijo de la FK del responsable.
CREATE INDEX "patient_responsible_parties_responsible_idx"
  ON "patient_responsible_parties"("tenantId", "responsiblePatientId")
  WHERE "responsiblePatientId" IS NOT NULL;
-- Un solo pagador principal vivo por paciente.
CREATE UNIQUE INDEX "patient_responsible_parties_one_payer_key"
  ON "patient_responsible_parties"("tenantId", "patientId")
  WHERE "isPayer" AND "deletedAt" IS NULL;
-- El mismo paciente responsable, una sola vez.
CREATE UNIQUE INDEX "patient_responsible_parties_patient_link_key"
  ON "patient_responsible_parties"("tenantId", "patientId", "responsiblePatientId")
  WHERE "deletedAt" IS NULL AND "responsiblePatientId" IS NOT NULL;
-- La copia del acudiente antiguo, una sola vez por paciente (aunque se quite
-- después): hace idempotente la migración de guardian*.
CREATE UNIQUE INDEX "patient_responsible_parties_migrated_key"
  ON "patient_responsible_parties"("tenantId", "patientId")
  WHERE "migratedFromGuardian";

ALTER TABLE "patient_responsible_parties" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "patient_responsible_parties"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "patient_responsible_parties" FORCE ROW LEVEL SECURITY;
