-- DX-009: registro de auditoría de accesos y cambios a datos clínicos y
-- financieros (Ley 1581, Res. 1995/1999, RGPD).
--
-- Cambios:
--   AuditAction, AuditResourceType  enums nuevos.
--   audit_events                    una fila por petición auditada: actor,
--                                   rol, acción, recurso, paciente, sede,
--                                   request id (DX-023), IP, user agent y
--                                   metadata SIN contenido clínico.
--   triggers                        append-only: ni UPDATE ni DELETE ni
--                                   TRUNCATE para el rol de la app.
--   RLS                             forzada por tenant, mismo predicado que el
--                                   resto de tablas de clínica (DX-068).
--
-- Compatible hacia atrás: solo AÑADE (dos enums, una tabla con sus índices,
-- una función, sus triggers y la política). No toca ninguna tabla existente.
--
-- Sin claves foráneas a propósito: el registro es evidencia y no puede impedir
-- (RESTRICT) ni seguir en cascada (CASCADE) el borrado de lo que referencia.
-- La API resuelve paciente y actor bajo RLS antes de escribir, así que los ids
-- siempre son de la misma clínica.
--
-- Retención: no se borra. Va con la historia clínica (Res. 1995/1999).
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas
-- (igual que 20261016170000_data_processing_consents). La inmutabilidad NO
-- depende de privilegios, que varían por entorno: la ponen los triggers.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "AuditAction" AS ENUM ('VIEW', 'CREATE', 'UPDATE', 'DELETE', 'SIGN', 'VOID', 'LOGIN', 'LOGIN_FAILED', 'EXPORT', 'PRINT');

CREATE TYPE "AuditResourceType" AS ENUM ('SESSION', 'PATIENT', 'MEDICAL_HISTORY', 'CLINICAL_ENTRY', 'ODONTOGRAM', 'PERIO_EXAM', 'CONSENT', 'DATA_CONSENT', 'PRESCRIPTION', 'TREATMENT_PLAN', 'TREATMENT_PLAN_ITEM', 'PAYMENT', 'PAYMENT_PLAN', 'ACCOUNT_STATEMENT');

-- ---------------------------------------------------------------------------
-- 2. Tabla
-- ---------------------------------------------------------------------------
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID,
    "actorUserId" UUID,
    "actorRole" "ClinicRole",
    "action" "AuditAction" NOT NULL,
    "resourceType" "AuditResourceType" NOT NULL,
    "resourceId" UUID,
    "patientId" UUID,
    "requestId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"),
    -- La metadata es siempre un objeto (la API la sanea antes de escribir).
    CONSTRAINT "audit_events_metadata_object_check" CHECK (jsonb_typeof("metadata") = 'object'),
    -- Solo un login fallido puede no tener actor (email que no es de la clínica).
    CONSTRAINT "audit_events_actor_check" CHECK ("actorUserId" IS NOT NULL OR "action" = 'LOGIN_FAILED')
);

-- ---------------------------------------------------------------------------
-- 3. Índices: la pantalla de auditoría (clínica entera, más reciente primero),
--    los accesos de un paciente y la actividad de un usuario.
-- ---------------------------------------------------------------------------
CREATE INDEX "audit_events_tenantId_occurredAt_idx" ON "audit_events"("tenantId", "occurredAt" DESC);

CREATE INDEX "audit_events_tenantId_patientId_occurredAt_idx" ON "audit_events"("tenantId", "patientId", "occurredAt");

CREATE INDEX "audit_events_tenantId_actorUserId_occurredAt_idx" ON "audit_events"("tenantId", "actorUserId", "occurredAt");

-- ---------------------------------------------------------------------------
-- 4. Append-only en la BD (no solo "no hay endpoint").
--    * UPDATE: prohibido siempre, para cualquier rol.
--    * DELETE y TRUNCATE: prohibidos salvo a un superusuario (purga
--      administrativa y limpieza de las bases de test con la conexión de
--      administración). El rol de la app nunca es superusuario.
-- ---------------------------------------------------------------------------
-- Una sola función para los dos triggers: en el de fila (DELETE) devolver OLD
-- deja seguir el borrado; en el de sentencia (TRUNCATE) OLD es NULL y Postgres
-- ignora lo que devuelva.
CREATE FUNCTION "dx_forbid_audit_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es append-only: no se permite % (DX-009)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "audit_events_append_only"
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "dx_forbid_audit_mutation"();

CREATE TRIGGER "audit_events_no_truncate"
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_forbid_audit_mutation"();

-- ---------------------------------------------------------------------------
-- 5. RLS forzada (mismo patrón que data_processing_consents / patients).
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "audit_events"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
