-- DX-274: idempotencia de POST /expenses y POST /expenses/:id/payments.
--
-- Mismo contrato que los abonos (DX-109): la cabecera Idempotency-Key (UUID) y
-- la huella de la petición se guardan con la fila; repetir la MISMA petición
-- devuelve la original y otra distinta con la misma clave es un 422. El único
-- es PARCIAL (solo filas con clave) y por clínica.
--
-- Compatible hacia atrás: solo AÑADE dos columnas nulas a cada tabla y sus
-- índices. Los triggers de inmutabilidad (expense_payments_guard) no miran
-- estas columnas: se fijan en el INSERT y la anulación no las toca.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "expenses"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "idempotencyFingerprint" TEXT;
ALTER TABLE "expense_payments"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "idempotencyFingerprint" TEXT;

CREATE UNIQUE INDEX "expenses_tenant_idempotency_key"
  ON "expenses"("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
CREATE UNIQUE INDEX "expense_payments_tenant_idempotency_key"
  ON "expense_payments"("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
