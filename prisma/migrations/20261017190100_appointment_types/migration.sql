-- DX-121: tipos de cita con duración y color, y tipo opcional en la cita.
--
-- Cambios:
--   appointment_types               tipos de cita de la clínica (nombre,
--                                   duración múltiplo de 5 entre 5 y 480 min,
--                                   color #RRGGBB, activo). Borrado lógico.
--   appointments.appointmentTypeId  tipo de la cita (NULL = sin tipo), con FK
--                                   COMPUESTA (tenantId, appointmentTypeId):
--                                   el tipo tiene que ser del MISMO tenant.
--
-- Compatible hacia atrás: solo AÑADE (una tabla, una columna NULL sin default,
-- índices, FK, CHECK y RLS). El código anterior ignora lo nuevo. La columna nace
-- toda a NULL, así que la FK se valida sin recorrer datos reales.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas
-- (igual que 20261016200000_prescriptions).

-- ---------------------------------------------------------------------------
-- appointment_types
-- ---------------------------------------------------------------------------
CREATE TABLE "appointment_types" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "color" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "appointment_types_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "appointment_types_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 60),
    -- La API responde 400 en español antes; esto es la red.
    CONSTRAINT "appointment_types_duration_check"
      CHECK ("durationMinutes" BETWEEN 5 AND 480 AND "durationMinutes" % 5 = 0),
    -- Solo #RRGGBB: el color se pinta en la agenda y nunca puede ser CSS libre.
    CONSTRAINT "appointment_types_color_check" CHECK ("color" ~ '^#[0-9A-Fa-f]{6}$')
);

-- Dos tipos VIVOS de la misma clínica no comparten nombre; uno retirado
-- (deletedAt) no bloquea reutilizarlo. También sirve el listado por clínica
-- ordenado por nombre.
CREATE UNIQUE INDEX "appointment_types_tenant_name_key" ON "appointment_types"("tenantId", "name") WHERE "deletedAt" IS NULL;

-- Destino de la FK compuesta de appointments (SEC-004).
CREATE UNIQUE INDEX "appointment_types_tenant_id_key" ON "appointment_types"("tenantId", "id");

ALTER TABLE "appointment_types" ADD CONSTRAINT "appointment_types_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "appointment_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_types" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "appointment_types"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- appointments.appointmentTypeId
-- ---------------------------------------------------------------------------
ALTER TABLE "appointments" ADD COLUMN "appointmentTypeId" UUID;

-- Lado hijo de la FK compuesta: sin él, retirar/actualizar un tipo recorrería
-- toda la tabla de citas.
CREATE INDEX "appointments_tenantId_appointmentTypeId_idx" ON "appointments"("tenantId", "appointmentTypeId");

-- MATCH SIMPLE (el default): con appointmentTypeId NULL la FK no se evalúa.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenantId_appointmentTypeId_fkey"
  FOREIGN KEY ("tenantId", "appointmentTypeId") REFERENCES "appointment_types"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
