-- DX-439: «Pendiente de cerrar» — citas pasadas sin desenlace, atendidas sin
-- evolución y tratamiento de la cita sin marcar como hecho.
--
-- Cambios:
--   closing_queue_dismissals   descarte de UN pendiente (sección + cita
--                              [+ ítem]) con motivo de una lista cerrada; OTHER
--                              lleva texto de 3–200. No toca la cita, la
--                              historia ni el plan: solo lo saca de la lista.
--
-- Índices de la lista: ninguno nuevo en appointments. Con 30.000 citas en 14
-- días (EXPLAIN ANALYZE en loop/informes/DX-439.md) el planificador recorre la
-- ventana por appointments_tenant_start_live_idx o, para un profesional,
-- appointments_tenantId_providerId_start_idx, y las tres secciones responden
-- bajo RLS en < 120 ms; un índice parcial por sede y estado no se elegía. El
-- NOT EXISTS de la evolución usa clinical_entries_tenant_patient_appointment_idx
-- y el del ítem, appointment_plan_items_item_idx.
--
-- Reglas en la BD:
--   * FK COMPUESTAS por tenant (SEC-004): la cita y el ítem son de la MISMA
--     clínica y del MISMO paciente que el descarte. RESTRICT: un descarte no
--     se reescribe ni desaparece en cascada.
--   * Un descarte por pendiente: UNIQUE (tenantId, section, appointmentId,
--     planItemId) NULLS NOT DISTINCT (PG ≥ 15), que además sirve el NOT EXISTS
--     de la lista.
--   * Ítem solo y siempre en TREATMENT; texto solo y siempre con OTHER.
--   * Append-only (trigger + REVOKE): solo un superusuario borra (limpieza de
--     tests); "createdAt" lo pone la BD en UTC.
--   * RLS FORCE con NULLIF, como el resto de tablas de clínica.
--
-- Compatible hacia atrás: AÑADE enums y una tabla vacía. El código anterior
-- no los conoce.

SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ClosingQueueSection" AS ENUM ('OUTCOME', 'EVOLUTION', 'TREATMENT');

-- CreateEnum
CREATE TYPE "ClosingDismissalReason" AS ENUM ('PATIENT_DECLINED_TODAY', 'PAPER_NOTE', 'DUPLICATE_APPOINTMENT', 'OTHER');

-- CreateTable
CREATE TABLE "closing_queue_dismissals" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "section" "ClosingQueueSection" NOT NULL,
    "patientId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "planItemId" UUID,
    "reasonCode" "ClosingDismissalReason" NOT NULL,
    "reasonText" VARCHAR(200),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "closing_queue_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "closing_queue_dismissals_tenant_id_key" ON "closing_queue_dismissals"("tenantId", "id");

-- CreateIndex
CREATE INDEX "closing_queue_dismissals_tenant_appointment_idx" ON "closing_queue_dismissals"("tenantId", "patientId", "appointmentId");

-- CreateIndex
CREATE INDEX "closing_queue_dismissals_tenant_plan_item_idx" ON "closing_queue_dismissals"("tenantId", "patientId", "planItemId");

-- CreateIndex
CREATE INDEX "closing_queue_dismissals_created_by_idx" ON "closing_queue_dismissals"("createdById");

-- Un descarte por pendiente (NULLS NOT DISTINCT: en OUTCOME y EVOLUTION el
-- ítem es NULL y dos descartes de la misma cita chocan igual).
CREATE UNIQUE INDEX "closing_queue_dismissals_pending_key"
  ON "closing_queue_dismissals"("tenantId", "section", "appointmentId", "planItemId") NULLS NOT DISTINCT;

-- AddForeignKey
ALTER TABLE "closing_queue_dismissals" ADD CONSTRAINT "closing_queue_dismissals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closing_queue_dismissals" ADD CONSTRAINT "closing_queue_dismissals_appointment_fkey" FOREIGN KEY ("tenantId", "patientId", "appointmentId") REFERENCES "appointments"("tenantId", "patientId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "closing_queue_dismissals" ADD CONSTRAINT "closing_queue_dismissals_plan_item_fkey" FOREIGN KEY ("tenantId", "patientId", "planItemId") REFERENCES "treatment_plan_items"("tenantId", "patientId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "closing_queue_dismissals" ADD CONSTRAINT "closing_queue_dismissals_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CHECKs
-- ---------------------------------------------------------------------------
ALTER TABLE "closing_queue_dismissals"
  ADD CONSTRAINT "closing_queue_dismissals_item_check"
    CHECK (("section" = 'TREATMENT') = ("planItemId" IS NOT NULL)),
  ADD CONSTRAINT "closing_queue_dismissals_reason_text_check"
    CHECK (
      CASE WHEN "reasonCode" = 'OTHER'
        THEN "reasonText" IS NOT NULL
             AND "reasonText" = btrim("reasonText")
             AND char_length("reasonText") BETWEEN 3 AND 200
        ELSE "reasonText" IS NULL
      END
    );

-- ---------------------------------------------------------------------------
-- Fecha del servidor y append-only: sin UPDATE; DELETE/TRUNCATE solo de un
-- superusuario (como patient_credit_*, DX-253).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx439_server_created_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "closing_queue_dismissals_server_created_at"
  BEFORE INSERT ON "closing_queue_dismissals"
  FOR EACH ROW EXECUTE FUNCTION public.dx439_server_created_at();

CREATE FUNCTION public.closing_queue_dismissals_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND public.dx_cash_is_superuser() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es un registro de auditoría: no admite % (DX-439)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "closing_queue_dismissals_append_only"
  BEFORE UPDATE OR DELETE ON "closing_queue_dismissals"
  FOR EACH ROW EXECUTE FUNCTION public.closing_queue_dismissals_append_only();
CREATE TRIGGER "closing_queue_dismissals_no_truncate"
  BEFORE TRUNCATE ON "closing_queue_dismissals"
  FOR EACH STATEMENT EXECUTE FUNCTION public.closing_queue_dismissals_append_only();

-- ---------------------------------------------------------------------------
-- RLS FORCE
-- ---------------------------------------------------------------------------
ALTER TABLE "closing_queue_dismissals" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "closing_queue_dismissals"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "closing_queue_dismissals" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Grants: los privilegios por defecto dan a dentalix_app SELECT, INSERT,
-- UPDATE y DELETE; aquí se recortan (REVOKE de tabla primero).
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON "closing_queue_dismissals" FROM dentalix_app;
GRANT SELECT, INSERT ON "closing_queue_dismissals" TO dentalix_app;
