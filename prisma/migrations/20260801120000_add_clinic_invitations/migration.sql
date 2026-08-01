-- CreateTable
CREATE TABLE "clinic_invitations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" "ClinicRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "invitedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "clinic_invitations_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "clinic_invitations" ADD CONSTRAINT "clinic_invitations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "clinic_invitations_tenantId_idx" ON "clinic_invitations"("tenantId");

-- Búsqueda por token en el endpoint público (se consulta por hash, nunca por
-- el token en claro, que no se persiste).
CREATE INDEX "clinic_invitations_tokenHash_idx" ON "clinic_invitations"("tokenHash");

-- Único PARCIAL: una sola invitación PENDIENTE por (clínica, correo). Una
-- invitación aceptada/revocada/borrada no debe bloquear volver a invitar.
CREATE UNIQUE INDEX "clinic_invitations_pending_key" ON "clinic_invitations"("tenantId", "email")
  WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL AND "deletedAt" IS NULL;

-- RLS (mismo patrón que las migraciones previas): la invitación se consulta
-- SIEMPRE con el tenant ya resuelto por host, así que puede ir protegida.
ALTER TABLE "clinic_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clinic_invitations" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "clinic_invitations"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
