-- DX-122: bloqueos de agenda por profesional o sede, y «Pendientes por agendar».
--
-- Cambios:
--   schedule_blocks       bloqueo [start, end) de un profesional (en una sede o
--                         en todas) o de toda una sede. `allowsBooking` decide si
--                         se puede agendar encima (con aviso) o no (409).
--                         Borrado lógico.
--   appointment_waitlist  pacientes por volver a agendar: los crea la API al
--                         cancelar o marcar no-show una cita (uno por cita:
--                         único parcial por "sourceAppointmentId") o recepción a
--                         mano. Se cierran agendando o descartando con motivo.
--
-- Compatible hacia atrás: solo CREA (tres enums, dos tablas, sus índices, FK,
-- CHECK y RLS). No toca ninguna tabla existente: las FK van en las tablas NUEVAS
-- (que nacen vacías), así que no hace falta quitar FORCE a nadie ni recorrer
-- datos. Funciona con un owner sin SUPERUSER ni BYPASSRLS (DX-113).
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas
-- (igual que 20261017190100_appointment_types).

CREATE TYPE "ScheduleBlockKind" AS ENUM ('VACATION', 'MEETING', 'LUNCH', 'OTHER');
CREATE TYPE "WaitlistPriority" AS ENUM ('NORMAL', 'URGENT');
CREATE TYPE "WaitlistStatus" AS ENUM ('OPEN', 'SCHEDULED', 'DISMISSED');

-- ---------------------------------------------------------------------------
-- schedule_blocks
-- ---------------------------------------------------------------------------
CREATE TABLE "schedule_blocks" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID,
    "providerId" UUID,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "kind" "ScheduleBlockKind" NOT NULL,
    "allowsBooking" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "schedule_blocks_pkey" PRIMARY KEY ("id"),
    -- Medio abierto [start, end), como las citas: un bloqueo vacío no existe.
    CONSTRAINT "schedule_blocks_range_check" CHECK ("end" > "start"),
    -- Toda la sede (sin profesional) exige sede; un profesional sin sede es
    -- "en todas las sedes".
    CONSTRAINT "schedule_blocks_scope_check"
      CHECK ("providerId" IS NOT NULL OR "locationId" IS NOT NULL),
    -- La API responde 400 en español antes; esto es la red.
    CONSTRAINT "schedule_blocks_note_check"
      CHECK ("note" IS NULL OR length("note") BETWEEN 1 AND 200)
);

-- Consultas de rango por sede y por profesional (`end > desde AND start <
-- hasta`). NO parciales: el de sede es además el lado hijo de la FK compuesta,
-- que tiene que ver también los bloqueos retirados.
CREATE INDEX "schedule_blocks_tenant_location_end_idx" ON "schedule_blocks"("tenantId", "locationId", "end");
CREATE INDEX "schedule_blocks_tenant_provider_end_idx" ON "schedule_blocks"("tenantId", "providerId", "end");

ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- FK COMPUESTA (SEC-004): la sede tiene que ser del MISMO tenant. MATCH SIMPLE
-- (el default): con "locationId" NULL no se evalúa.
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_tenantId_locationId_fkey"
  FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "schedule_blocks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "schedule_blocks" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "schedule_blocks"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- appointment_waitlist
-- ---------------------------------------------------------------------------
CREATE TABLE "appointment_waitlist" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "sourceAppointmentId" UUID,
    "providerId" UUID,
    "appointmentTypeId" UUID,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "priority" "WaitlistPriority" NOT NULL DEFAULT 'NORMAL',
    "preferredWindow" TEXT,
    "note" TEXT,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAppointmentId" UUID,
    "dismissReason" TEXT,
    "createdById" UUID,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointment_waitlist_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "appointment_waitlist_duration_check"
      CHECK ("durationMinutes" BETWEEN 5 AND 480 AND "durationMinutes" % 5 = 0),
    CONSTRAINT "appointment_waitlist_preferred_window_check"
      CHECK ("preferredWindow" IS NULL OR length("preferredWindow") BETWEEN 1 AND 80),
    CONSTRAINT "appointment_waitlist_note_check"
      CHECK ("note" IS NULL OR length("note") BETWEEN 1 AND 500),
    CONSTRAINT "appointment_waitlist_dismiss_reason_check"
      CHECK ("dismissReason" IS NULL OR length(btrim("dismissReason")) BETWEEN 1 AND 200),
    -- Cada estado con lo suyo: OPEN sin resolución; SCHEDULED con la cita que
    -- la resolvió; DISMISSED con su motivo.
    CONSTRAINT "appointment_waitlist_status_check" CHECK (
      ("status" = 'OPEN' AND "resolvedAt" IS NULL AND "resolvedAppointmentId" IS NULL AND "dismissReason" IS NULL)
      OR ("status" = 'SCHEDULED' AND "resolvedAt" IS NOT NULL AND "resolvedAppointmentId" IS NOT NULL AND "dismissReason" IS NULL)
      OR ("status" = 'DISMISSED' AND "resolvedAt" IS NOT NULL AND "resolvedAppointmentId" IS NULL AND "dismissReason" IS NOT NULL)
    )
);

-- Destino de FK compuestas futuras y unicidad (tenant, id).
CREATE UNIQUE INDEX "appointment_waitlist_tenant_id_key" ON "appointment_waitlist"("tenantId", "id");

-- Idempotencia: una sola entrada por cita cancelada/no-show, aunque su estado
-- cambie dos veces (CANCELLED -> NO_SHOW) o dos peticiones compitan. PARCIAL:
-- las altas manuales no tienen cita de origen.
CREATE UNIQUE INDEX "appointment_waitlist_tenant_source_key" ON "appointment_waitlist"("tenantId", "sourceAppointmentId") WHERE "sourceAppointmentId" IS NOT NULL;

-- El panel (OPEN de una sede por antigüedad); también lado hijo de la FK a la sede.
CREATE INDEX "appointment_waitlist_tenant_location_status_idx" ON "appointment_waitlist"("tenantId", "locationId", "status", "createdAt");
-- Lados hijo de las FK compuestas.
CREATE INDEX "appointment_waitlist_tenantId_patientId_idx" ON "appointment_waitlist"("tenantId", "patientId");
CREATE INDEX "appointment_waitlist_tenantId_resolvedAppointmentId_idx" ON "appointment_waitlist"("tenantId", "resolvedAppointmentId");
CREATE INDEX "appointment_waitlist_tenantId_appointmentTypeId_idx" ON "appointment_waitlist"("tenantId", "appointmentTypeId");

ALTER TABLE "appointment_waitlist" ADD CONSTRAINT "appointment_waitlist_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- FK COMPUESTAS (SEC-004): sede, paciente, citas y tipo, del MISMO tenant.
-- CASCADE en paciente y citas: la entrada es dato derivado y el producto nunca
-- borra en duro (no-hard-delete); solo afecta a la limpieza administrativa.
ALTER TABLE "appointment_waitlist" ADD CONSTRAINT "appointment_waitlist_tenantId_locationId_fkey"
  FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_waitlist" ADD CONSTRAINT "appointment_waitlist_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_waitlist" ADD CONSTRAINT "appointment_waitlist_tenantId_sourceAppointmentId_fkey"
  FOREIGN KEY ("tenantId", "sourceAppointmentId") REFERENCES "appointments"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_waitlist" ADD CONSTRAINT "appointment_waitlist_tenantId_resolvedAppointmentId_fkey"
  FOREIGN KEY ("tenantId", "resolvedAppointmentId") REFERENCES "appointments"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_waitlist" ADD CONSTRAINT "appointment_waitlist_tenantId_appointmentTypeId_fkey"
  FOREIGN KEY ("tenantId", "appointmentTypeId") REFERENCES "appointment_types"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "appointment_waitlist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_waitlist" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "appointment_waitlist"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
