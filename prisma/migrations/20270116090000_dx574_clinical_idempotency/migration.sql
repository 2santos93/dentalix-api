-- DX-574: altas clínicas idempotentes para los reintentos tras un corte de red
-- (borradores que sobreviven a un corte de luz o de internet).
--
-- Evolución (POST /patients/:id/clinical-entries), anamnesis del personal
-- (PUT /patients/:id/medical-history, que añade una versión), plan
-- (POST /patients/:id/treatment-plans), ítem del plan
-- (POST /treatment-plans/:id/items) y receta (POST /patients/:id/prescriptions).
--
-- Mismo contrato que los abonos (DX-109), los gastos (DX-274) y «Atender sin
-- cita» (DX-510): la cabecera Idempotency-Key (UUID) y la huella de la petición
-- se guardan con la fila que crea; repetir la MISMA petición devuelve esa fila y
-- otra distinta con la misma clave es un 422. La clave vive con su fila (sin
-- TTL). Aislamiento: el único es PARCIAL (solo filas con clave) y por clínica
-- ("tenantId" va en él; las constraints saltan la RLS).
--
-- Compatible hacia atrás y aditiva: dos columnas nulas sin DEFAULT por tabla
-- (solo catálogo) y un índice único nuevo por tabla. Ninguna fila existente
-- tiene clave, así que los índices no pueden fallar. El código anterior no lee
-- ni escribe estas columnas. Los triggers de inmutabilidad (DX-038 evolución,
-- receta sellada) solo miran los UPDATE: estas columnas se escriben en el
-- INSERT y no cambian nunca.
--
-- Bloqueo: CREATE UNIQUE INDEX (no CONCURRENTLY: Prisma corre la migración en
-- una transacción) toma SHARE sobre cada tabla mientras la recorre: bloquea
-- escrituras, no lecturas. Ninguna fila entra en el índice parcial (todas
-- tienen la clave NULL): en tablas de decenas de miles de filas, decenas de
-- milisegundos cada una.
--
-- Vuelta atrás, por tabla: DROP INDEX "<tabla>_tenant_idempotency_key";
-- ALTER TABLE "<tabla>" DROP COLUMN "idempotencyKey", DROP COLUMN
-- "idempotencyFingerprint" (sin pérdida de datos clínicos).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "clinical_entries"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "idempotencyFingerprint" TEXT;

CREATE UNIQUE INDEX "clinical_entries_tenant_idempotency_key"
  ON "clinical_entries"("tenantId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

ALTER TABLE "medical_history_versions"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "idempotencyFingerprint" TEXT;

CREATE UNIQUE INDEX "medical_history_versions_tenant_idempotency_key"
  ON "medical_history_versions"("tenantId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

ALTER TABLE "treatment_plans"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "idempotencyFingerprint" TEXT;

CREATE UNIQUE INDEX "treatment_plans_tenant_idempotency_key"
  ON "treatment_plans"("tenantId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

ALTER TABLE "treatment_plan_items"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "idempotencyFingerprint" TEXT;

-- El único de "treatment_plan_items" (tabla caliente) va CONCURRENTLY en
-- 20270116090100_dx574_plan_items_idempotency_idx.

ALTER TABLE "prescriptions"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "idempotencyFingerprint" TEXT;

CREATE UNIQUE INDEX "prescriptions_tenant_idempotency_key"
  ON "prescriptions"("tenantId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
