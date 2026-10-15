-- DX-005: confirmación de cita por enlace firmado (Confirmar / Cancelar /
-- Quiero que me llamen).
--
-- Compatible hacia atrás: solo AÑADE (un enum, dos columnas NULL en
-- appointments, un UNIQUE sobre (tenantId, id) que ya es único porque `id` es
-- la PK, y una tabla nueva). No reescribe ni borra datos; el código anterior
-- ignora las columnas nuevas.
--
-- Grants: no se requiere GRANT explícito. Corre con el rol owner "dentalix"
-- y ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en las tablas nuevas.

-- CreateEnum
CREATE TYPE "AppointmentConfirmationResponse" AS ENUM ('CONFIRM', 'CANCEL', 'CALL_ME');

-- Reflejo en la agenda. NULL por defecto: un ADD COLUMN sin DEFAULT es un
-- cambio solo de catálogo (no reescribe la tabla).
ALTER TABLE "appointments" ADD COLUMN "confirmationSentAt" TIMESTAMP(3),
ADD COLUMN "callbackRequestedAt" TIMESTAMP(3);

-- Destino de la FK compuesta de abajo (mismo patrón que locations/patients en
-- 20261015130000_tenant_composite_fks). `id` ya es PK, así que no puede fallar
-- por duplicados.
CREATE UNIQUE INDEX "appointments_tenant_id_key" ON "appointments"("tenantId", "id");

-- CreateTable
CREATE TABLE "appointment_confirmations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "appointmentStart" TIMESTAMP(3) NOT NULL,
    "appointmentStatus" "AppointmentStatus" NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "response" "AppointmentConfirmationResponse",
    "revokedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointment_confirmations_pkey" PRIMARY KEY ("id")
);

-- Búsqueda por token en el endpoint público (siempre por hash; el token en
-- claro no se persiste). UNIQUE: dos enlaces nunca comparten token.
CREATE UNIQUE INDEX "appointment_confirmations_tokenHash_key" ON "appointment_confirmations"("tokenHash");

-- Revocar los enlaces pendientes de una cita al emitir uno nuevo; además
-- indexa el lado hijo de la FK compuesta.
CREATE INDEX "appointment_confirmations_tenantId_appointmentId_idx" ON "appointment_confirmations"("tenantId", "appointmentId");

ALTER TABLE "appointment_confirmations" ADD CONSTRAINT "appointment_confirmations_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- FK COMPUESTA (SEC-004): la cita tiene que ser del MISMO tenant. CASCADE a
-- propósito: el enlace es dato derivado de la cita, y la cita nunca se borra
-- en duro en el producto (no-hard-delete); solo afecta a limpiezas
-- administrativas, que así no quedan bloqueadas por enlaces huérfanos.
ALTER TABLE "appointment_confirmations" ADD CONSTRAINT "appointment_confirmations_tenantId_appointmentId_fkey"
  FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "appointments"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS (mismo patrón que clinic_invitations): el enlace se consulta SIEMPRE con
-- el tenant ya resuelto por host, así que un token de la clínica A usado en el
-- host de la clínica B no encuentra fila.
ALTER TABLE "appointment_confirmations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_confirmations" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "appointment_confirmations"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
