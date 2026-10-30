-- DX-377 (porción 1): medios de pago de la clínica con referencia del pago.
--
-- Cambios:
--   "PaymentMethodKind"   tipo base de un medio: los 4 métodos de siempre más
--                         DIGITAL (solo en el catálogo; el abono con un medio
--                         DIGITAL sigue escribiendo method = TRANSFER).
--   payment_methods       catálogo por clínica: nombre (1-60), tipo base,
--                         activo, «pide referencia» y "legacyMethod" (los 4
--                         medios iniciales, uno por método antiguo, único por
--                         clínica). No se borra: se desactiva.
--   payments."paymentMethodId"          medio del abono, FK COMPUESTA
--                         (tenantId, paymentMethodId): del MISMO tenant.
--   payments."reference"                referencia del pagador (1-60).
--   payments."referenceNormalized"      la misma sin espacios y en mayúsculas,
--                         para buscar repetidas (índice en 20261103120200).
--   payments."duplicateReferenceReason" motivo con que se confirmó una
--                         referencia repetida (1-300).
--
-- Compatible hacia atrás: solo AÑADE (un enum, una tabla vacía, columnas NULL
-- sin DEFAULT, CHECK y FK NOT VALID, RLS). Una réplica anterior no nombra las
-- columnas nuevas y sigue escribiendo "method"; sus abonos nacen sin medio y la
-- API nueva los cuenta por el medio inicial de su método. El relleno
-- (20261103120100) crea los medios iniciales y enlaza los abonos; los CHECK
-- se validan en 20261103120300 y la FK se queda NOT VALID (ver allí).
--
-- ADD COLUMN y ADD CONSTRAINT NOT VALID toman un ACCESS EXCLUSIVE breve sobre
-- payments, sin leerla. lock_timeout 5 s: si una transacción larga lo retiene,
-- falla limpia (`prisma migrate resolve --rolled-back` y de nuevo el deploy).
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "PaymentMethodKind" AS ENUM ('CASH', 'CARD', 'TRANSFER', 'DIGITAL', 'OTHER');

CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PaymentMethodKind" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "requiresReference" BOOLEAN NOT NULL DEFAULT false,
    "legacyMethod" "PaymentMethod",
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id"),
    -- La API responde 400 en español antes; esto es la red.
    CONSTRAINT "payment_methods_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 60),
    CONSTRAINT "payment_methods_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Destino de la FK compuesta de payments (SEC-004).
CREATE UNIQUE INDEX "payment_methods_tenant_id_key" ON "payment_methods"("tenantId", "id");
-- Nombre único por clínica; también sirve el listado ordenado por nombre.
CREATE UNIQUE INDEX "payment_methods_tenant_name_key" ON "payment_methods"("tenantId", "name");
-- Un único medio inicial por método antiguo y clínica. PARCIAL: el WHERE vive
-- solo aquí; NO aceptes un diff de migrate dev que lo vuelva completo.
CREATE UNIQUE INDEX "payment_methods_tenant_legacy_key" ON "payment_methods"("tenantId", "legacyMethod") WHERE "legacyMethod" IS NOT NULL;

ALTER TABLE "payment_methods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_methods" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "payment_methods"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- La app lee, da de alta y edita; nunca borra (un medio se desactiva).
REVOKE DELETE, TRUNCATE ON "payment_methods" FROM dentalix_app;

ALTER TABLE "payments"
  ADD COLUMN "paymentMethodId" UUID,
  ADD COLUMN "reference" TEXT,
  ADD COLUMN "referenceNormalized" TEXT,
  ADD COLUMN "duplicateReferenceReason" TEXT;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_reference_check" CHECK (
    ("reference" IS NULL AND "referenceNormalized" IS NULL)
    OR (
      length(btrim("reference")) BETWEEN 1 AND 60
      AND "referenceNormalized" IS NOT NULL
      AND length("referenceNormalized") BETWEEN 1 AND 60
    )
  ) NOT VALID,
  ADD CONSTRAINT "payments_duplicate_reference_reason_check" CHECK (
    "duplicateReferenceReason" IS NULL
    OR (
      "referenceNormalized" IS NOT NULL
      AND length(btrim("duplicateReferenceReason")) BETWEEN 1 AND 300
    )
  ) NOT VALID;

-- MATCH SIMPLE: con "paymentMethodId" NULL la FK no se evalúa.
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_method_fkey"
  FOREIGN KEY ("tenantId", "paymentMethodId") REFERENCES "payment_methods"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
