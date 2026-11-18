-- DX-016: reserva online v1 (página pública /reservar).
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   appointments."origin"   STAFF (por defecto) | ONLINE: la marca «Online»
--                           de la agenda. NOT NULL con DEFAULT constante: en
--                           PG 16 solo toca el catálogo (sin reescritura).
--   online_booking_settings  ajustes de la clínica (una fila; sin fila =
--                           desactivada). Topes por CHECK.
--   appointment_type_online_settings  el tipo de cita del catálogo en la
--                           reserva online: visible, duración para nuevos y
--                           existentes, profesionales y sedes.
--   online_booking_requests  cada envío de la página: la bandeja «Solicitudes
--                           online» y la huella de las reservas directas.
--   online_booking_verifications  código de un solo uso del email y sesión.
--
-- FK de las tablas nuevas DENTRO de los CREATE TABLE (nacen vacías). FK
-- directa a tenants con RESTRICT; las demás COMPUESTAS por clínica. RLS ENABLE
-- + FORCE con la política NULLIF (DX-251). La app nunca borra estas filas.
--
-- Vuelta atrás: desplegar la API anterior y
--   DROP TABLE public."online_booking_verifications";
--   DROP TABLE public."online_booking_requests";
--   DROP TABLE public."appointment_type_online_settings";
--   DROP TABLE public."online_booking_settings";
--   ALTER TABLE public."appointments" DROP COLUMN "origin";
--   DROP TYPE "AppointmentOrigin"; DROP TYPE "OnlineBookingMode";
--   DROP TYPE "OnlineBookingStatus"; DROP TYPE "OnlineBookingPatientKind";

SET LOCAL lock_timeout = '5s';

CREATE TYPE "AppointmentOrigin" AS ENUM ('STAFF', 'ONLINE');
CREATE TYPE "OnlineBookingMode" AS ENUM ('REQUEST', 'DIRECT');
CREATE TYPE "OnlineBookingStatus" AS ENUM ('PENDING', 'BOOKED', 'ACCEPTED', 'DECLINED');
CREATE TYPE "OnlineBookingPatientKind" AS ENUM ('NEW', 'EXISTING');

ALTER TABLE "appointments"
  ADD COLUMN "origin" "AppointmentOrigin" NOT NULL DEFAULT 'STAFF';

-- ---------------------------------------------------------------------------
-- online_booking_settings
-- ---------------------------------------------------------------------------

CREATE TABLE "online_booking_settings" (
    "tenantId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "newPatientMode" "OnlineBookingMode" NOT NULL DEFAULT 'REQUEST',
    "existingPatientMode" "OnlineBookingMode" NOT NULL DEFAULT 'REQUEST',
    "minLeadMinutesNew" INTEGER NOT NULL DEFAULT 120,
    "minLeadMinutesExisting" INTEGER NOT NULL DEFAULT 120,
    "maxAdvanceDays" INTEGER NOT NULL DEFAULT 60,
    "slotStepMinutes" INTEGER NOT NULL DEFAULT 15,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "online_booking_settings_pkey" PRIMARY KEY ("tenantId"),
    CONSTRAINT "online_booking_settings_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "online_booking_settings_updated_by_fkey"
      FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Antelación mínima de 0 a 7 días; máxima de 1 a 365 días; paso de 5 a
    -- 60 minutos en múltiplos de 5 (la agenda alinea a 5 minutos).
    CONSTRAINT "online_booking_settings_values_check" CHECK (
      "minLeadMinutesNew" BETWEEN 0 AND 10080
      AND "minLeadMinutesExisting" BETWEEN 0 AND 10080
      AND "maxAdvanceDays" BETWEEN 1 AND 365
      AND "slotStepMinutes" BETWEEN 5 AND 60
      AND "slotStepMinutes" % 5 = 0
    )
);
CREATE INDEX "online_booking_settings_updated_by_idx" ON "online_booking_settings"("updatedById");

ALTER TABLE "online_booking_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "online_booking_settings"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "online_booking_settings" FORCE ROW LEVEL SECURITY;
REVOKE DELETE, TRUNCATE ON "online_booking_settings" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- appointment_type_online_settings
-- ---------------------------------------------------------------------------

CREATE TABLE "appointment_type_online_settings" (
    "tenantId" UUID NOT NULL,
    "appointmentTypeId" UUID NOT NULL,
    "visibleOnline" BOOLEAN NOT NULL DEFAULT false,
    "durationNewMinutes" INTEGER,
    "durationExistingMinutes" INTEGER,
    "providerIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "locationIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointment_type_online_settings_pkey" PRIMARY KEY ("tenantId", "appointmentTypeId"),
    CONSTRAINT "appointment_type_online_settings_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "appointment_type_online_settings_type_fkey"
      FOREIGN KEY ("tenantId", "appointmentTypeId") REFERENCES "appointment_types"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "appointment_type_online_settings_updated_by_fkey"
      FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Duraciones como las del tipo (DX-121): múltiplo de 5 entre 5 y 480.
    -- Listas de como mucho 200 ids, sin NULL.
    CONSTRAINT "appointment_type_online_settings_values_check" CHECK (
      ("durationNewMinutes" IS NULL
        OR ("durationNewMinutes" BETWEEN 5 AND 480 AND "durationNewMinutes" % 5 = 0))
      AND ("durationExistingMinutes" IS NULL
        OR ("durationExistingMinutes" BETWEEN 5 AND 480 AND "durationExistingMinutes" % 5 = 0))
      AND "providerIds" IS NOT NULL AND "locationIds" IS NOT NULL
      AND cardinality("providerIds") <= 200 AND cardinality("locationIds") <= 200
      AND array_position("providerIds", NULL) IS NULL
      AND array_position("locationIds", NULL) IS NULL
    )
);
CREATE INDEX "appointment_type_online_settings_updated_by_idx"
  ON "appointment_type_online_settings"("updatedById");

ALTER TABLE "appointment_type_online_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "appointment_type_online_settings"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "appointment_type_online_settings" FORCE ROW LEVEL SECURITY;
REVOKE DELETE, TRUNCATE ON "appointment_type_online_settings" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- online_booking_requests
-- ---------------------------------------------------------------------------

CREATE TABLE "online_booking_requests" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "appointmentTypeId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "patientKind" "OnlineBookingPatientKind" NOT NULL,
    "mode" "OnlineBookingMode" NOT NULL,
    "status" "OnlineBookingStatus" NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "possibleDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "contactEmail" VARCHAR(254),
    "contactPhone" VARCHAR(40),
    "appointmentId" UUID,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "online_booking_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "online_booking_requests_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "online_booking_requests_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "online_booking_requests_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "online_booking_requests_type_fkey"
      FOREIGN KEY ("tenantId", "appointmentTypeId") REFERENCES "appointment_types"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "online_booking_requests_appointment_fkey"
      FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "appointments"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "online_booking_requests_provider_fkey"
      FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "online_booking_requests_decided_by_fkey"
      FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Cada estado con sus columnas:
    --   PENDING   una solicitud sin decidir ni cita;
    --   BOOKED    reserva directa: su cita, sin decisión de recepción;
    --   ACCEPTED  solicitud aceptada: su cita y quién/cuándo;
    --   DECLINED  rechazada: quién/cuándo, sin cita.
    CONSTRAINT "online_booking_requests_state_check" CHECK (
      "end" > "start"
      AND CASE "status"
        WHEN 'PENDING' THEN "mode" = 'REQUEST' AND "appointmentId" IS NULL
          AND "decidedById" IS NULL AND "decidedAt" IS NULL
        WHEN 'BOOKED' THEN "mode" = 'DIRECT' AND "appointmentId" IS NOT NULL
          AND "decidedById" IS NULL AND "decidedAt" IS NULL
        WHEN 'ACCEPTED' THEN "mode" = 'REQUEST' AND "appointmentId" IS NOT NULL
          AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL
        ELSE "mode" = 'REQUEST' AND "appointmentId" IS NULL
          AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL
      END
    )
);
CREATE UNIQUE INDEX "online_booking_requests_appointment_key"
  ON "online_booking_requests"("tenantId", "appointmentId");
CREATE INDEX "online_booking_requests_inbox_idx"
  ON "online_booking_requests"("tenantId", "status", "locationId", "createdAt" DESC);
CREATE INDEX "online_booking_requests_patient_idx" ON "online_booking_requests"("tenantId", "patientId");
CREATE INDEX "online_booking_requests_location_idx" ON "online_booking_requests"("tenantId", "locationId");
CREATE INDEX "online_booking_requests_type_idx" ON "online_booking_requests"("tenantId", "appointmentTypeId");
CREATE INDEX "online_booking_requests_provider_idx" ON "online_booking_requests"("providerId");
CREATE INDEX "online_booking_requests_decided_by_idx"
  ON "online_booking_requests"("decidedById") WHERE "decidedById" IS NOT NULL;

ALTER TABLE "online_booking_requests" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "online_booking_requests"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "online_booking_requests" FORCE ROW LEVEL SECURITY;
REVOKE DELETE, TRUNCATE ON "online_booking_requests" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- online_booking_verifications
-- ---------------------------------------------------------------------------

CREATE TABLE "online_booking_verifications" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID,
    "patientKind" "OnlineBookingPatientKind" NOT NULL,
    "codeHmac" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "sessionTokenHash" TEXT,
    "sessionExpiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "online_booking_verifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "online_booking_verifications_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "online_booking_verifications_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Hash hex de 64; intentos 0–5; la sesión con su caducidad, solo tras
    -- verificar y con un paciente; un código con su caducidad.
    CONSTRAINT "online_booking_verifications_values_check" CHECK (
      "attempts" BETWEEN 0 AND 5
      AND ("codeHmac" IS NULL OR "codeHmac" ~ '^[0-9a-f]{64}$')
      AND (("codeHmac" IS NULL) = ("codeExpiresAt" IS NULL))
      AND ("sessionTokenHash" IS NULL OR "sessionTokenHash" ~ '^[0-9a-f]{64}$')
      AND (("sessionTokenHash" IS NULL) = ("sessionExpiresAt" IS NULL))
      AND ("sessionTokenHash" IS NULL
        OR ("verifiedAt" IS NOT NULL AND "patientId" IS NOT NULL))
      AND ("consumedAt" IS NULL OR "sessionTokenHash" IS NOT NULL)
    )
);
CREATE UNIQUE INDEX "online_booking_verifications_session_key"
  ON "online_booking_verifications"("tenantId", "sessionTokenHash");
CREATE INDEX "online_booking_verifications_patient_idx"
  ON "online_booking_verifications"("tenantId", "patientId", "createdAt");

ALTER TABLE "online_booking_verifications" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "online_booking_verifications"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "online_booking_verifications" FORCE ROW LEVEL SECURITY;
REVOKE DELETE, TRUNCATE ON "online_booking_verifications" FROM dentalix_app;
