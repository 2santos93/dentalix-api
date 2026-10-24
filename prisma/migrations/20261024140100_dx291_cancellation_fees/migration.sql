-- DX-291 (porción 2 de DX-279): cargo por inasistencia o cancelación tardía
-- y constancia de la política enviada en cada recordatorio.
--
-- 1. `cancellation_fees`: UNA fila por cita (índice único por clínica y cita)
--    con lo que se decidió: CHARGED (el cargo es un ítem DONE del plan
--    «Cargos administrativos», que se cobra con el abono y el recibo de
--    siempre) o WAIVED (condonado con motivo). El índice único es lo que hace
--    idempotente el cargo: dos peticiones simultáneas dejan una sola fila (la
--    otra recibe 409). APPEND-ONLY para la app (sin UPDATE/DELETE): es la
--    prueba de lo que se cobró o se perdonó. RLS FORCE y FK compuestas.
-- 2. `appointment_reminders."policyVersionId"`: la versión de la política que
--    llevaba cada recordatorio enviado (FK compuesta). La cita guarda además
--    la última comunicada en `appointments."policyVersionId"` (DX-279).
--
-- Compatible hacia atrás: tabla nueva y vacía, y una columna NULLABLE sin
-- default en `appointment_reminders` (solo catálogo, no la reescribe). El
-- código anterior no las conoce ni las escribe.
--
-- Bloqueo: ADD COLUMN y NO/FORCE toman ACCESS EXCLUSIVE un instante (solo
-- catálogo) sobre las tablas tocadas; las FK nuevas validan tablas vacías o
-- una columna recién creada (toda NULL). lock_timeout evita quedar encolado
-- detrás de una transacción larga. Los índices parciales van aparte,
-- CONCURRENTLY.
--
-- FK bajo FORCE (DX-134): NO FORCE en las hijas y en las referenciadas que lo
-- tienen, en esta misma transacción, y FORCE de vuelta al final.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "appointments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_items" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "cancellation_policy_versions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointment_reminders" NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 1. Cargo o condonación de una cita.
-- ---------------------------------------------------------------------------
CREATE TABLE "cancellation_fees" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "appointmentId" UUID NOT NULL,
  "patientId" UUID NOT NULL,
  "locationId" UUID NOT NULL,
  -- Versión comunicada al paciente (la de la cita al decidir). Obligatoria en
  -- un cargo; una condonación puede no tenerla.
  "policyVersionId" UUID,
  "status" "CancellationFeeStatus" NOT NULL,
  "amount" DECIMAL(14,2),
  "currency" TEXT,
  "planItemId" UUID,
  "waiveReason" VARCHAR(500),
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', now()),
  CONSTRAINT "cancellation_fees_pkey" PRIMARY KEY ("id"),
  -- CHARGED: importe > 0, moneda, ítem y versión; sin motivo de condonación.
  -- WAIVED: motivo de 3 a 500 caracteres; sin importe, moneda ni ítem.
  CONSTRAINT "cancellation_fees_status_check" CHECK (
    ("status" = 'CHARGED'
      AND "amount" IS NOT NULL AND "amount" > 0
      AND "currency" IS NOT NULL AND "planItemId" IS NOT NULL
      AND "policyVersionId" IS NOT NULL AND "waiveReason" IS NULL)
    OR ("status" = 'WAIVED'
      AND "amount" IS NULL AND "currency" IS NULL AND "planItemId" IS NULL
      AND "waiveReason" IS NOT NULL
      AND char_length(btrim("waiveReason")) BETWEEN 3 AND 500)
  )
);

-- Idempotencia: una decisión por cita. También es el lado hijo de la FK a la
-- cita (su prefijo).
CREATE UNIQUE INDEX "cancellation_fees_tenant_appointment_key"
  ON "cancellation_fees" ("tenantId", "appointmentId");
-- Planes «Cargos administrativos» del paciente (busca el plan abierto de su
-- moneda) y lado hijo de la FK al ítem (tenantId, patientId, planItemId).
CREATE INDEX "cancellation_fees_tenant_patient_item_idx"
  ON "cancellation_fees" ("tenantId", "patientId", "planItemId");
CREATE INDEX "cancellation_fees_tenant_location_idx"
  ON "cancellation_fees" ("tenantId", "locationId");
CREATE INDEX "cancellation_fees_created_by_idx"
  ON "cancellation_fees" ("createdById");
CREATE INDEX "cancellation_fees_currency_idx"
  ON "cancellation_fees" ("currency") WHERE "currency" IS NOT NULL;

ALTER TABLE "cancellation_fees"
  ADD CONSTRAINT "cancellation_fees_appointment_fkey"
    FOREIGN KEY ("tenantId", "appointmentId")
    REFERENCES "appointments"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- El paciente es el de la cita: la FK al ítem va por (tenant, paciente, id).
  ADD CONSTRAINT "cancellation_fees_plan_item_fkey"
    FOREIGN KEY ("tenantId", "patientId", "planItemId")
    REFERENCES "treatment_plan_items"("tenantId", "patientId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cancellation_fees_location_fkey"
    FOREIGN KEY ("tenantId", "locationId")
    REFERENCES "locations"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cancellation_fees_policy_version_fkey"
    FOREIGN KEY ("tenantId", "policyVersionId")
    REFERENCES "cancellation_policy_versions"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cancellation_fees_currency_fkey"
    FOREIGN KEY ("currency") REFERENCES "currencies"("code")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cancellation_fees_created_by_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cancellation_fees" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cancellation_fees"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- La app inserta y lee; los privilegios por defecto le dan además UPDATE y
-- DELETE: se quitan (la decisión no se reescribe).
GRANT SELECT, INSERT ON "cancellation_fees" TO dentalix_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "cancellation_fees" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- 2. Versión de la política enviada en cada recordatorio.
-- ---------------------------------------------------------------------------
ALTER TABLE "appointment_reminders" ADD COLUMN "policyVersionId" UUID;
ALTER TABLE "appointment_reminders"
  ADD CONSTRAINT "appointment_reminders_policy_version_fkey"
    FOREIGN KEY ("tenantId", "policyVersionId")
    REFERENCES "cancellation_policy_versions"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cancellation_fees" FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointment_reminders" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cancellation_policy_versions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
