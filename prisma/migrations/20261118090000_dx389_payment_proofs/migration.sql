-- DX-389: comprobante del cobro adjunto al abono.
--   payment_methods.proofPolicy   «Pide comprobante»: NONE | OPTIONAL | REQUIRED
--                                 (defecto NONE: aditiva, ningún medio cambia).
--   payment_proofs                como mucho un comprobante por abono (JPG, PNG,
--                                 WebP o PDF); la clave del objeto es privada.
-- Aditiva: columna con defecto + tabla nueva. RLS FORCE por clínica.
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "PaymentProofPolicy" AS ENUM ('NONE', 'OPTIONAL', 'REQUIRED');

ALTER TABLE "payment_methods"
  ADD COLUMN "proofPolicy" "PaymentProofPolicy" NOT NULL DEFAULT 'NONE';

CREATE TABLE "payment_proofs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_proofs_pkey" PRIMARY KEY ("id"),
    -- La API responde 400 en español antes; esto es la red.
    CONSTRAINT "payment_proofs_mime_check"
      CHECK ("mime" IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
    CONSTRAINT "payment_proofs_size_check" CHECK ("size" > 0 AND "size" <= 10485760),
    CONSTRAINT "payment_proofs_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "payment_proofs_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Del MISMO tenant que el abono (SEC-004).
    CONSTRAINT "payment_proofs_payment_fkey" FOREIGN KEY ("tenantId", "paymentId")
      REFERENCES "payments"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Como mucho un comprobante por abono.
CREATE UNIQUE INDEX "payment_proofs_tenant_payment_key" ON "payment_proofs"("tenantId", "paymentId");
-- Una clave de almacén pertenece a una sola fila.
CREATE UNIQUE INDEX "payment_proofs_key_key" ON "payment_proofs"("key");

ALTER TABLE "payment_proofs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_proofs" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "payment_proofs"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Append-only: la app lee y da de alta; el comprobante no se cambia ni se
-- borra (la anulación del abono no lo toca: es evidencia).
REVOKE UPDATE, DELETE, TRUNCATE ON "payment_proofs" FROM dentalix_app;
