-- DX-037: autorización de tratamiento de datos (Ley 1581 / Dec. 1377)
-- versionada y con prueba.
--
-- Hasta ahora la autorización era un booleano (`patients.dataConsentAccepted`)
-- que se sobrescribía, sin texto, canal ni evidencia. Esta migración añade:
--   * privacy_policy_versions: la política publicada por clínica, inmutable.
--   * data_processing_consents: una fila por decisión (append-only), por
--     scope (GENERAL / SENSITIVE_HEALTH / MARKETING). Revocar es otra fila con
--     granted = false; el estado vigente es la última fila de cada scope.
-- y pasa el booleano actual a filas LEGACY, sin pérdida.
--
-- Compatible hacia atrás: solo AÑADE (dos enums, dos tablas, una función y
-- sus triggers) e INSERTA las filas LEGACY. No cambia ni borra columnas de
-- patients: `dataConsentAccepted/At/PolicyVersion` se quedan (deprecadas) y la
-- app las sigue escribiendo como resumen derivado de la última fila GENERAL,
-- así que el código anterior sigue leyendo lo mismo.
--
-- Grants: no se requiere GRANT explícito. Corre con el rol owner "dentalix" y
-- ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en las tablas nuevas. La
-- inmutabilidad NO depende de privilegios (que varían por entorno): la ponen
-- los triggers de la sección 5.

-- ---------------------------------------------------------------------------
-- 0. row_security = off (transacción actual), mismo criterio que
--    20261015130000_tenant_composite_fks: `patients` tiene RLS FORCE, y el
--    INSERT ... SELECT de la sección 6 contaría 0 filas en silencio si el rol
--    que migra no salta la RLS. Así, o ve todas las filas, o la migración falla
--    ("query would be affected by row-level security policy") en vez de
--    perder datos sin avisar.
-- ---------------------------------------------------------------------------
SET LOCAL row_security = off;
-- DX-113: con un owner sin superusuario ni BYPASSRLS, FORCE lo sujeta a la RLS
-- y, con row_security = off, fallan la validación de la FK a `patients` y el
-- backfill. Se quita FORCE en esta misma transacción y se restaura al final
-- de la sección 7: el resultado es el mismo.
ALTER TABLE "patients" NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "DataConsentScope" AS ENUM ('GENERAL', 'SENSITIVE_HEALTH', 'MARKETING');

CREATE TYPE "DataConsentChannel" AS ENUM ('IN_PERSON', 'LEGACY');

-- ---------------------------------------------------------------------------
-- 2. Tablas
-- ---------------------------------------------------------------------------
CREATE TABLE "privacy_policy_versions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "policyText" TEXT NOT NULL,
    "generalText" TEXT NOT NULL,
    "sensitiveHealthText" TEXT NOT NULL,
    "marketingText" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedById" UUID NOT NULL,

    CONSTRAINT "privacy_policy_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "privacy_policy_versions_version_check" CHECK ("version" >= 1)
);

CREATE TABLE "data_processing_consents" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "policyVersionId" UUID,
    "legacyPolicyVersion" TEXT,
    "scope" "DataConsentScope" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "channel" "DataConsentChannel" NOT NULL,
    "recordedById" UUID,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "data_processing_consents_pkey" PRIMARY KEY ("id"),
    -- Una fila que no es LEGACY es una prueba completa: versión de política
    -- aceptada y quién la registró. Solo el booleano heredado (y los clientes
    -- que aún mandan el campo deprecado) se quedan sin texto versionado.
    CONSTRAINT "data_processing_consents_evidence_check" CHECK (
      "channel" = 'LEGACY'
      OR ("policyVersionId" IS NOT NULL AND "recordedById" IS NOT NULL)
    )
);

-- ---------------------------------------------------------------------------
-- 3. Índices
-- ---------------------------------------------------------------------------
-- Número de versión correlativo por clínica; dos publicaciones simultáneas
-- chocan aquí (409 vía PrismaExceptionFilter) en vez de duplicar la versión.
-- También sirve el "vigente = mayor versión" (ORDER BY version DESC).
CREATE UNIQUE INDEX "privacy_policy_versions_tenant_version_key" ON "privacy_policy_versions"("tenantId", "version");

-- Destino de la FK compuesta de data_processing_consents (SEC-004). `id` ya es
-- PK, así que no puede fallar por duplicados.
CREATE UNIQUE INDEX "privacy_policy_versions_tenant_id_key" ON "privacy_policy_versions"("tenantId", "id");

-- Estado vigente (última fila por scope) e historial del paciente, ordenado
-- por recordedAt; además indexa el lado hijo de la FK compuesta a patients.
CREATE INDEX "data_processing_consents_tenantId_patientId_scope_recordedA_idx" ON "data_processing_consents"("tenantId", "patientId", "scope", "recordedAt");

-- Lado hijo de la FK compuesta a privacy_policy_versions.
CREATE INDEX "data_processing_consents_tenantId_policyVersionId_idx" ON "data_processing_consents"("tenantId", "policyVersionId");

-- ---------------------------------------------------------------------------
-- 4. Claves foráneas. RESTRICT en todas: la prueba no desaparece porque se
--    retire su paciente, su política o quien la registró (nada de eso se
--    borra en duro en el producto).
-- ---------------------------------------------------------------------------
ALTER TABLE "privacy_policy_versions" ADD CONSTRAINT "privacy_policy_versions_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "privacy_policy_versions" ADD CONSTRAINT "privacy_policy_versions_publishedById_fkey"
  FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "data_processing_consents" ADD CONSTRAINT "data_processing_consents_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- FK COMPUESTA (SEC-004): el paciente tiene que ser del MISMO tenant.
ALTER TABLE "data_processing_consents" ADD CONSTRAINT "data_processing_consents_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- FK COMPUESTA (SEC-004): la política aceptada tiene que ser de la MISMA
-- clínica. MATCH SIMPLE: con policyVersionId NULL (LEGACY) no se comprueba.
ALTER TABLE "data_processing_consents" ADD CONSTRAINT "data_processing_consents_tenantId_policyVersionId_fkey"
  FOREIGN KEY ("tenantId", "policyVersionId") REFERENCES "privacy_policy_versions"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "data_processing_consents" ADD CONSTRAINT "data_processing_consents_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. Inmutabilidad en la BD (no solo "no hay endpoint").
--    * UPDATE: prohibido siempre, para cualquier rol. Una política publicada
--      no se edita (se publica otra versión) y una autorización no se
--      corrige (se registra otra decisión).
--    * DELETE: prohibido salvo a un superusuario (purga administrativa y
--      fixtures de test con la conexión de administración). El rol de la app
--      nunca es superusuario.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "dx_forbid_consent_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es append-only: no se permite % (DX-037)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "privacy_policy_versions_immutable"
  BEFORE UPDATE OR DELETE ON "privacy_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION "dx_forbid_consent_mutation"();

CREATE TRIGGER "data_processing_consents_append_only"
  BEFORE UPDATE OR DELETE ON "data_processing_consents"
  FOR EACH ROW EXECUTE FUNCTION "dx_forbid_consent_mutation"();

-- ---------------------------------------------------------------------------
-- 6. RLS (mismo patrón que appointment_confirmations / patients).
-- ---------------------------------------------------------------------------
ALTER TABLE "privacy_policy_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "privacy_policy_versions" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "privacy_policy_versions"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "data_processing_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_processing_consents" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "data_processing_consents"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- 7. Backfill: el booleano actual pasa a filas LEGACY, sin pérdida.
--    * Toda decisión registrada (aceptó, o hay fecha de decisión aunque no
--      aceptara) da una fila GENERAL con su valor, su fecha y su etiqueta de
--      versión. Incluye pacientes retirados (deletedAt): la prueba se conserva.
--    * `false` sin fecha es el valor por defecto de la columna, no una
--      decisión: no se inventa una fila (el silencio no es una respuesta).
--    * `recordedAt` conserva la fecha original (o la de la última
--      modificación del paciente si no la había), así los campos derivados
--      quedan exactamente como estaban.
--    * Sin `recordedById`: el booleano no guardaba quién registró la decisión
--      y `createdById` (quién creó la ficha) no es lo mismo.
-- ---------------------------------------------------------------------------
-- DX-113: misma razón que con `patients` en la sección 0, para la tabla nueva.
ALTER TABLE "data_processing_consents" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "data_processing_consents" (
    "id", "tenantId", "patientId", "policyVersionId", "legacyPolicyVersion",
    "scope", "granted", "channel", "recordedById", "recordedAt"
)
SELECT
    gen_random_uuid(), p."tenantId", p."id", NULL, p."dataConsentPolicyVersion",
    'GENERAL', p."dataConsentAccepted", 'LEGACY', NULL,
    COALESCE(p."dataConsentAt", p."updatedAt")
FROM "patients" p
WHERE p."dataConsentAccepted" = true OR p."dataConsentAt" IS NOT NULL;

ALTER TABLE "data_processing_consents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;
