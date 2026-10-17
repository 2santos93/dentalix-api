-- DX-210: hueco libre → candidatos.
--
-- Cambios:
--   appointments."wantsEarlier"  «Adelantar si hay hueco» (default false). Con
--                                default constante Postgres no reescribe la
--                                tabla: las filas existentes lo leen del
--                                catálogo.
--   appointments_tenant_location_wants_earlier_idx  índice PARCIAL de las
--                                citas candidatas (marcadas, vivas, agendadas
--                                o confirmadas) por sede e inicio.
--   waitlist_offers              oferta de un hueco a un candidato (pendiente
--                                de la lista o cita a adelantar), por wa.me o
--                                teléfono, con su resultado. `offerDay` = día
--                                civil en la zona de la sede (tope por día).
--   audit_events                 índice parcial de WAITLIST_OFFER (DX-102).
--
-- FK COMPUESTAS por tenant (SEC-004): sede, paciente, entrada y cita de la
-- MISMA clínica. Van DENTRO del CREATE TABLE (nace vacía): el owner sin
-- BYPASSRLS no necesita ver filas de las tablas padre (DX-134).
--
-- Compatible hacia atrás: solo AÑADE (una columna con default, dos enums, una
-- tabla vacía, índices y RLS). El código anterior no escribe la columna (queda
-- en false) ni la tabla.
--
-- Bloqueo: el ADD COLUMN toma ACCESS EXCLUSIVE sobre appointments un instante
-- (sin reescritura); el CREATE INDEX no concurrente bloquea las escrituras de
-- citas mientras recorre la tabla. lock_timeout evita quedar encolado detrás
-- de una transacción larga.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "appointments" ADD COLUMN "wantsEarlier" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "appointments_tenant_location_wants_earlier_idx"
  ON "appointments"("tenantId", "locationId", "start")
  WHERE "wantsEarlier" AND "deletedAt" IS NULL AND "status" IN ('SCHEDULED', 'CONFIRMED');

CREATE TYPE "WaitlistOfferChannel" AS ENUM ('WA_ME', 'PHONE');
CREATE TYPE "WaitlistOfferOutcome" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'NO_ANSWER');

CREATE TABLE "waitlist_offers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "slotStart" TIMESTAMP(3) NOT NULL,
    "slotEnd" TIMESTAMP(3) NOT NULL,
    "providerId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "waitlistEntryId" UUID,
    "appointmentId" UUID,
    "channel" "WaitlistOfferChannel" NOT NULL,
    "outcome" "WaitlistOfferOutcome" NOT NULL DEFAULT 'PENDING',
    "offerDay" DATE NOT NULL,
    "createdById" UUID NOT NULL,
    "outcomeById" UUID,
    "outcomeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "waitlist_offers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "waitlist_offers_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTAS: todo lo referenciado es de la MISMA clínica.
    CONSTRAINT "waitlist_offers_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- CASCADE en paciente, entrada y cita: la oferta es dato derivado, y el
    -- producto nunca borra en duro (como appointment_waitlist).
    CONSTRAINT "waitlist_offers_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "waitlist_offers_entry_fkey"
      FOREIGN KEY ("tenantId", "waitlistEntryId") REFERENCES "appointment_waitlist"("tenantId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "waitlist_offers_appointment_fkey"
      FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "appointments"("tenantId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "waitlist_offers_slot_check" CHECK ("slotEnd" > "slotStart"),
    -- Se ofrece a un pendiente, a una cita o (sin ninguno) al paciente.
    CONSTRAINT "waitlist_offers_target_check"
      CHECK (num_nonnulls("waitlistEntryId", "appointmentId") <= 1),
    -- Con resultado = con quién y cuándo lo anotó; pendiente = sin ellos.
    CONSTRAINT "waitlist_offers_outcome_check"
      CHECK (("outcome" = 'PENDING') = ("outcomeAt" IS NULL))
);

-- Tope por paciente y día (zona de la sede); también lado hijo de la FK al paciente.
CREATE INDEX "waitlist_offers_tenant_patient_day_idx"
  ON "waitlist_offers"("tenantId", "patientId", "offerDay");
-- «Aviso enviado» de los huecos de una sede; también lado hijo de la FK a la sede.
CREATE INDEX "waitlist_offers_tenant_location_slot_idx"
  ON "waitlist_offers"("tenantId", "locationId", "slotStart");
-- Lados hijos de las FK a la entrada y a la cita.
CREATE INDEX "waitlist_offers_tenant_entry_idx"
  ON "waitlist_offers"("tenantId", "waitlistEntryId");
CREATE INDEX "waitlist_offers_tenant_appointment_idx"
  ON "waitlist_offers"("tenantId", "appointmentId");

ALTER TABLE "waitlist_offers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "waitlist_offers"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "waitlist_offers" FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS "audit_events_resource_waitlist_offer_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'WAITLIST_OFFER';
