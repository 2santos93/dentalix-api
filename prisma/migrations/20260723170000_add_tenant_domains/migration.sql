-- CreateEnum
CREATE TYPE "TenantDomainStatus" AS ENUM ('PENDING', 'VERIFIED');

-- CreateTable
CREATE TABLE "tenant_domains" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "host" TEXT NOT NULL,
    "status" "TenantDomainStatus" NOT NULL DEFAULT 'PENDING',
    "verifyToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "tenant_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_domains_host_key" ON "tenant_domains"("host");

-- CreateIndex
CREATE INDEX "tenant_domains_tenantId_idx" ON "tenant_domains"("tenantId");

-- AddForeignKey
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Nota: tenant_domains es infraestructura de ruteo host->tenant. Se consulta
-- ANTES de conocer el tenant (para resolverlo), por lo que NO lleva RLS -- igual
-- que tenants/users. El aislamiento en las rutas de gestion (/domains) lo impone
-- el repositorio filtrando por el tenant del contexto (TenantContextService).
