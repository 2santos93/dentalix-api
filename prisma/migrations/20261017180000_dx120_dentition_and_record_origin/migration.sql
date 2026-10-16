-- DX-120: odontograma fase 2 — dentición temporal y mixta, origen del
-- registro y anulación con motivo.
--
-- Cambios:
--   tooth_records
--       + "origin" (THIS_CLINIC por defecto, PRE_EXISTING, OTHER_PROVIDER).
--       + "voidsRecordId" / "voidReason": una anulación es OTRO registro que
--         apunta al anulado y guarda el motivo (adenda, no edición; misma idea
--         que DX-038). CHECK: una anulación lleva motivo.
--       Inalterable en la BD: UPDATE prohibido siempre; DELETE y TRUNCATE solo
--       para un superusuario (purga administrativa y limpieza de bases de
--       test), igual que clinical_entries (DX-038). La app nunca actualizó ni
--       borró estas filas (su repositorio solo inserta).
--   patient_dentition_events
--       cambios de dentición por posición (código FDI permanente), con
--       motivo (MANUAL, ERUPTION, EXFOLIATION) y autor obligatorio. FK
--       compuestas por tenant y paciente, RLS FORZADA y append-only.
--
-- Índices que van aparte (CONCURRENTLY, una sentencia por fichero, DB-025):
--   20261017180100 (tenantId, patientId, id) único, destino de la FK;
--   20261017180200 único parcial de "voidsRecordId" (se anula una sola vez);
--   20261017180300 FK de la anulación al registro anulado.
--
-- Compatible hacia atrás: columnas nuevas con valor por defecto o nulas (sin
-- reescritura de la tabla) y una tabla nueva. Grants: ALTER DEFAULT
-- PRIVILEGES ya cubre a dentalix_app en la tabla nueva.

-- DB-025: si una transacción larga retiene tooth_records, la migración falla
-- rápido en vez de encolar las escrituras del odontograma detrás.
SET LOCAL lock_timeout = '5s';

CREATE TYPE "ToothRecordOrigin" AS ENUM ('THIS_CLINIC', 'PRE_EXISTING', 'OTHER_PROVIDER');
CREATE TYPE "DentitionType" AS ENUM ('PERMANENT', 'PRIMARY', 'MIXED');
CREATE TYPE "DentitionEventReason" AS ENUM ('MANUAL', 'ERUPTION', 'EXFOLIATION');

-- ---------------------------------------------------------------------------
-- 1. tooth_records: origen y anulación
-- ---------------------------------------------------------------------------
ALTER TABLE "tooth_records"
  ADD COLUMN "origin" "ToothRecordOrigin" NOT NULL DEFAULT 'THIS_CLINIC',
  ADD COLUMN "voidsRecordId" UUID,
  ADD COLUMN "voidReason" TEXT;

-- NOT VALID + VALIDATE: el ALTER no recorre la tabla con el bloqueo fuerte;
-- la validación (todas las filas tienen las columnas nuevas a NULL) va con un
-- bloqueo que no frena las lecturas ni las escrituras.
ALTER TABLE "tooth_records" ADD CONSTRAINT "tooth_records_void_reason_required"
  CHECK ("voidsRecordId" IS NULL OR char_length(btrim("voidReason")) > 0) NOT VALID;
ALTER TABLE "tooth_records" ADD CONSTRAINT "tooth_records_void_reason_only_on_void"
  CHECK ("voidReason" IS NULL OR "voidsRecordId" IS NOT NULL) NOT VALID;
ALTER TABLE "tooth_records" ADD CONSTRAINT "tooth_records_void_reason_len"
  CHECK ("voidReason" IS NULL OR char_length("voidReason") <= 500) NOT VALID;
ALTER TABLE "tooth_records" ADD CONSTRAINT "tooth_records_void_not_self"
  CHECK ("voidsRecordId" IS NULL OR "voidsRecordId" <> "id") NOT VALID;
ALTER TABLE "tooth_records" VALIDATE CONSTRAINT "tooth_records_void_reason_required";
ALTER TABLE "tooth_records" VALIDATE CONSTRAINT "tooth_records_void_reason_only_on_void";
ALTER TABLE "tooth_records" VALIDATE CONSTRAINT "tooth_records_void_reason_len";
ALTER TABLE "tooth_records" VALIDATE CONSTRAINT "tooth_records_void_not_self";

-- ---------------------------------------------------------------------------
-- 2. Inmutabilidad del odontograma. Misma forma que
--    dx_forbid_clinical_record_mutation (DX-038): fila (UPDATE/DELETE) y
--    sentencia (TRUNCATE); el superusuario solo puede BORRAR (purga). Mensaje
--    propio: aquí la corrección es una anulación, no una adenda.
--    search_path fijo con pg_temp AL FINAL y pg_catalog.pg_roles calificado
--    (SEC-032): una tabla temporal "pg_roles" no puede suplantar al catálogo.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "dx_forbid_odontogram_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es append-only: no se permite % en el odontograma; para corregir un registro se anula con motivo (DX-120)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "tooth_records_immutable"
  BEFORE UPDATE OR DELETE ON "tooth_records"
  FOR EACH ROW EXECUTE FUNCTION "dx_forbid_odontogram_mutation"();
CREATE TRIGGER "tooth_records_no_truncate"
  BEFORE TRUNCATE ON "tooth_records"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_forbid_odontogram_mutation"();

-- ---------------------------------------------------------------------------
-- 3. patient_dentition_events
-- ---------------------------------------------------------------------------
CREATE TABLE "patient_dentition_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "position" TEXT NOT NULL,
    "dentition" "DentitionType" NOT NULL,
    "reason" "DentitionEventReason" NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_dentition_events_pkey" PRIMARY KEY ("id"),
    -- La posición se nombra por su código FDI PERMANENTE (cuadrantes 1-4).
    CONSTRAINT "patient_dentition_events_position_fdi"
      CHECK ("position" ~ '^[1-4][1-8]$'),
    -- Los molares (posiciones 6-8) no tienen predecesor temporal: no hay
    -- dentición mixta en ellos (PRIMARY = el permanente aún no ha erupcionado).
    CONSTRAINT "patient_dentition_events_mixed_has_primary"
      CHECK ("dentition" <> 'MIXED' OR substr("position", 2, 1) BETWEEN '1' AND '5'),
    -- Exfoliar es perder el temporal: la posición queda en permanente.
    CONSTRAINT "patient_dentition_events_exfoliation_leaves_permanent"
      CHECK ("reason" <> 'EXFOLIATION' OR "dentition" = 'PERMANENT')
);

-- Los eventos del paciente en orden cronológico (estado actual y carta a una
-- fecha: recordedAt <= corte).
CREATE INDEX "patient_dentition_events_patient_recorded_idx"
  ON "patient_dentition_events"("tenantId", "patientId", "recordedAt", "id");

-- DB-028: FK de tenantId explícita en la tabla nueva.
ALTER TABLE "patient_dentition_events" ADD CONSTRAINT "patient_dentition_events_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- SEC-004: el paciente debe ser de la misma clínica.
ALTER TABLE "patient_dentition_events" ADD CONSTRAINT "patient_dentition_events_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_dentition_events" ADD CONSTRAINT "patient_dentition_events_performedById_fkey"
  FOREIGN KEY ("performedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER "patient_dentition_events_immutable"
  BEFORE UPDATE OR DELETE ON "patient_dentition_events"
  FOR EACH ROW EXECUTE FUNCTION "dx_forbid_odontogram_mutation"();
CREATE TRIGGER "patient_dentition_events_no_truncate"
  BEFORE TRUNCATE ON "patient_dentition_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_forbid_odontogram_mutation"();
-- La fecha de grabación la pone el servidor (función de DX-038).
CREATE TRIGGER "patient_dentition_events_server_timestamp"
  BEFORE INSERT ON "patient_dentition_events"
  FOR EACH ROW EXECUTE FUNCTION "dx_clinical_record_server_timestamp"();

-- RLS forzada por tenant (mismo patrón que tooth_records).
ALTER TABLE "patient_dentition_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_dentition_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "patient_dentition_events"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
