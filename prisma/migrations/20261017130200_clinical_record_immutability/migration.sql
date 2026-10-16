-- DX-038: historia clínica inalterable (Res. 1995/1999, art. 18) + adendas de
-- corrección + autoría obligatoria.
--
-- Cambios:
--   clinical_entries, medical_history_versions
--       inmutables en la BD: UPDATE prohibido siempre; DELETE y TRUNCATE solo
--       para un superusuario (purga administrativa y limpieza de bases de
--       test). Mismo criterio que audit_events (DX-009); el rol de la app
--       (dentalix_app) nunca es superusuario. Ver DB-026 para el rol de purga
--       único que lo sustituirá.
--   clinical_entries
--       autoría obligatoria para lo nuevo: CHECK performedById NOT NULL
--       (NOT VALID: las filas antiguas sin autor se conservan tal cual, la HC
--       no se reescribe) y createdAt lo pone SIEMPRE el servidor de BD.
--   clinical_entry_addenda
--       nota aclaratoria fechada y firmada que corrige una evolución sin
--       tocarla: texto, motivo, autor (NOT NULL, FK a users) y fecha del
--       servidor. FK compuestas por tenant y paciente, RLS FORZADA y la misma
--       inmutabilidad (append-only).
--
-- Compatible hacia atrás: la app nunca actualizó ni borró estas filas (sus
-- repositorios no tienen método para ello) y siempre graba el autor desde el
-- JWT, así que el código anterior sigue funcionando igual.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en la tabla nueva
-- (igual que 20261016180000_patient_consents).

-- DB-025: si una transacción larga retiene clinical_entries, la migración falla
-- rápido en vez de encolar las escrituras de la HC detrás de su bloqueo.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Inmutabilidad. Una función para los triggers de fila (UPDATE/DELETE) y de
--    sentencia (TRUNCATE): en DELETE devolver OLD deja seguir el borrado; en
--    TRUNCATE OLD es NULL y Postgres ignora lo que devuelva.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "dx_forbid_clinical_record_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es inalterable: no se permite % en la historia clínica; para corregir se añade una adenda (DX-038)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "clinical_entries_immutable"
  BEFORE UPDATE OR DELETE ON "clinical_entries"
  FOR EACH ROW EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"();
CREATE TRIGGER "clinical_entries_no_truncate"
  BEFORE TRUNCATE ON "clinical_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"();

CREATE TRIGGER "medical_history_versions_immutable"
  BEFORE UPDATE OR DELETE ON "medical_history_versions"
  FOR EACH ROW EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"();
CREATE TRIGGER "medical_history_versions_no_truncate"
  BEFORE TRUNCATE ON "medical_history_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"();

-- ---------------------------------------------------------------------------
-- 2. Fecha de registro del servidor: ningún INSERT (ni de la app ni por SQL)
--    puede antedatar o postdatar el momento en que quedó grabado el asiento.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "dx_clinical_record_server_timestamp"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."createdAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "clinical_entries_server_timestamp"
  BEFORE INSERT ON "clinical_entries"
  FOR EACH ROW EXECUTE FUNCTION "dx_clinical_record_server_timestamp"();

-- ---------------------------------------------------------------------------
-- 3. Autoría obligatoria en las evoluciones nuevas. NOT VALID: no recorre ni
--    reescribe las filas existentes (bloqueo breve, sin validación en el
--    sitio — DB-025); se aplica a cada INSERT desde ya.
-- ---------------------------------------------------------------------------
ALTER TABLE "clinical_entries" ADD CONSTRAINT "clinical_entries_author_required"
  CHECK ("performedById" IS NOT NULL) NOT VALID;

-- ---------------------------------------------------------------------------
-- 4. clinical_entry_addenda
-- ---------------------------------------------------------------------------
CREATE TABLE "clinical_entry_addenda" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "clinicalEntryId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinical_entry_addenda_pkey" PRIMARY KEY ("id"),
    -- Mismos topes que el DTO (defensa en profundidad ante un INSERT por SQL).
    CONSTRAINT "clinical_entry_addenda_reason_len"
      CHECK (char_length(btrim("reason")) BETWEEN 10 AND 500),
    CONSTRAINT "clinical_entry_addenda_text_len"
      CHECK (char_length(btrim("text")) BETWEEN 1 AND 5000)
);

-- Listado de las adendas de una evolución (y de todas las del paciente, que
-- usa el listado de la HC) en orden cronológico.
CREATE INDEX "clinical_entry_addenda_entry_created_idx"
  ON "clinical_entry_addenda"("tenantId", "patientId", "clinicalEntryId", "createdAt");

-- DB-028: FK de tenantId explícita en la tabla nueva.
ALTER TABLE "clinical_entry_addenda" ADD CONSTRAINT "clinical_entry_addenda_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- SEC-004: el paciente debe ser de la misma clínica.
ALTER TABLE "clinical_entry_addenda" ADD CONSTRAINT "clinical_entry_addenda_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- La evolución corregida debe ser de la misma clínica Y del mismo paciente.
ALTER TABLE "clinical_entry_addenda" ADD CONSTRAINT "clinical_entry_addenda_tenantId_patientId_clinicalEntryId_fkey"
  FOREIGN KEY ("tenantId", "patientId", "clinicalEntryId") REFERENCES "clinical_entries"("tenantId", "patientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clinical_entry_addenda" ADD CONSTRAINT "clinical_entry_addenda_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER "clinical_entry_addenda_immutable"
  BEFORE UPDATE OR DELETE ON "clinical_entry_addenda"
  FOR EACH ROW EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"();
CREATE TRIGGER "clinical_entry_addenda_no_truncate"
  BEFORE TRUNCATE ON "clinical_entry_addenda"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"();
CREATE TRIGGER "clinical_entry_addenda_server_timestamp"
  BEFORE INSERT ON "clinical_entry_addenda"
  FOR EACH ROW EXECUTE FUNCTION "dx_clinical_record_server_timestamp"();

-- RLS forzada por tenant (mismo patrón que patient_consents).
ALTER TABLE "clinical_entry_addenda" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clinical_entry_addenda" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "clinical_entry_addenda"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
