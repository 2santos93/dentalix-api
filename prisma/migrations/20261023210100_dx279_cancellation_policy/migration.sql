-- DX-279 (porción 1): política de cancelación por sede y datos de la
-- cancelación y de la inasistencia de cada cita.
--
-- 1. `cancellation_policy_versions`: la política de una sede, APPEND-ONLY.
--    Editarla crea la versión siguiente; la anterior no cambia nunca (es la
--    prueba de qué se le comunicó al paciente). RLS FORCE por tenant y FK
--    compuestas a la sede.
-- 2. `appointments`: cuándo y quién canceló, el motivo (catálogo cerrado +
--    texto opcional), los minutos de aviso y si fue tardía (los calcula el
--    servidor en UTC), cuándo se marcó la inasistencia y la versión de la
--    política comunicada (FK compuesta; queda NULL hasta DX-291).
--
-- Compatible hacia atrás: tabla nueva y vacía, columnas NULLABLE sin default
-- (solo catálogo, sin reescribir `appointments`) y un CHECK que las citas
-- existentes cumplen: las canceladas y no-show antiguas no tienen ninguno de
-- estos datos, y «todos o ninguno» las admite. El código anterior no conoce
-- las columnas y nunca las escribe.
--
-- Bloqueo: ADD COLUMN y NO FORCE toman ACCESS EXCLUSIVE sobre `appointments`
-- un instante (solo catálogo); la FK nueva y el VALIDATE recorren la tabla sin
-- reescribirla. lock_timeout evita quedar encolado detrás de una transacción
-- larga. Los índices van aparte, CONCURRENTLY.
--
-- FK bajo FORCE (DX-134): añadir la FK de `appointments` a la tabla nueva
-- valida leyendo la hija con la RLS del owner, así que se quita FORCE a las
-- dos en esta misma transacción y se devuelve al final.

SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 1. Versiones de la política de cancelación de cada sede.
-- ---------------------------------------------------------------------------
CREATE TABLE "cancellation_policy_versions" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "locationId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "noticeHours" INTEGER NOT NULL,
  "suggestedFee" DECIMAL(14,2),
  "currency" TEXT,
  "patientText" VARCHAR(1000) NOT NULL DEFAULT '',
  "receptionCanCharge" BOOLEAN NOT NULL DEFAULT false,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', now()),
  CONSTRAINT "cancellation_policy_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cancellation_policy_versions_version_check" CHECK ("version" >= 1),
  CONSTRAINT "cancellation_policy_versions_notice_hours_check"
    CHECK ("noticeHours" BETWEEN 0 AND 168),
  CONSTRAINT "cancellation_policy_versions_fee_check"
    CHECK ("suggestedFee" IS NULL OR "suggestedFee" >= 0),
  CONSTRAINT "cancellation_policy_versions_fee_currency_check"
    CHECK (("suggestedFee" IS NULL) = ("currency" IS NULL)),
  CONSTRAINT "cancellation_policy_versions_text_check"
    CHECK (char_length("patientText") <= 1000)
);

-- Una versión por número y sede; también sirve la «vigente» (la de mayor
-- número) con un recorrido hacia atrás del índice.
CREATE UNIQUE INDEX "cancellation_policy_versions_location_version_key"
  ON "cancellation_policy_versions" ("tenantId", "locationId", "version");
-- Destino de la FK compuesta de `appointments.policyVersionId`.
CREATE UNIQUE INDEX "cancellation_policy_versions_tenant_id_key"
  ON "cancellation_policy_versions" ("tenantId", "id");
CREATE INDEX "cancellation_policy_versions_created_by_idx"
  ON "cancellation_policy_versions" ("createdById");

ALTER TABLE "cancellation_policy_versions"
  ADD CONSTRAINT "cancellation_policy_versions_location_fkey"
    FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cancellation_policy_versions_currency_fkey"
    FOREIGN KEY ("currency") REFERENCES "currencies"("code")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cancellation_policy_versions_created_by_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Inalterable: ni UPDATE ni DELETE ni TRUNCATE para la app (grants) y, además,
-- un trigger que los rechaza a cualquiera salvo el DELETE/TRUNCATE de un
-- superusuario (limpieza de las bases de test). No hay purga administrativa:
-- quien necesite borrar en producción es el owner, que tendría que quitar el
-- trigger a propósito. search_path fijo (SEC-032).
CREATE FUNCTION public."cancellation_policy_versions_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'cancellation_policy_versions es inalterable: cambiar la política crea una versión nueva (DX-279)'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "cancellation_policy_versions_immutable"
  BEFORE UPDATE OR DELETE ON "cancellation_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION public."cancellation_policy_versions_immutable"();
CREATE TRIGGER "cancellation_policy_versions_no_truncate"
  BEFORE TRUNCATE ON "cancellation_policy_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION public."cancellation_policy_versions_immutable"();

ALTER TABLE "cancellation_policy_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cancellation_policy_versions"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- La app inserta y lee; los privilegios por defecto le dan además UPDATE y
-- DELETE: se quitan.
GRANT SELECT, INSERT ON "cancellation_policy_versions" TO dentalix_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "cancellation_policy_versions" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- 2. Cancelación e inasistencia de la cita.
-- ---------------------------------------------------------------------------
ALTER TABLE "appointments"
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledByKind" "CancellationByKind",
  ADD COLUMN "cancelReasonCode" "CancellationReasonCode",
  ADD COLUMN "cancelReasonText" VARCHAR(500),
  ADD COLUMN "noticeMinutes" INTEGER,
  ADD COLUMN "lateCancellation" BOOLEAN,
  ADD COLUMN "noShowMarkedAt" TIMESTAMP(3),
  ADD COLUMN "policyVersionId" UUID;

-- Coherencia con el estado:
--  - solo una cita CANCELLED lleva datos de cancelación, y la hora, quién, los
--    minutos de aviso y si fue tardía van juntos (todos o ninguno: las
--    canceladas antiguas no tienen ninguno);
--  - el personal (en nombre del paciente o la clínica) siempre da motivo; el
--    enlace del paciente puede no traerlo; el texto libre solo con motivo;
--  - los minutos de aviso nunca son negativos (cancelar con la cita empezada
--    es aviso 0) y una cancelación de la clínica nunca es tardía;
--  - solo una cita NO_SHOW lleva la hora en que se marcó (las antiguas, no).
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_cancellation_check" CHECK (
    ("status" = 'CANCELLED' OR (
      "cancelledAt" IS NULL AND "cancelledByKind" IS NULL
      AND "cancelReasonCode" IS NULL AND "cancelReasonText" IS NULL
      AND "noticeMinutes" IS NULL AND "lateCancellation" IS NULL))
    AND num_nulls("cancelledAt", "cancelledByKind", "noticeMinutes", "lateCancellation") IN (0, 4)
    AND ("noticeMinutes" IS NULL OR "noticeMinutes" >= 0)
    AND ("cancelReasonCode" IS NULL OR "cancelledByKind" IS NOT NULL)
    AND ("cancelledByKind" IS NULL OR "cancelledByKind" = 'PATIENT_LINK'
         OR "cancelReasonCode" IS NOT NULL)
    AND ("cancelReasonText" IS NULL OR (
      "cancelReasonCode" IS NOT NULL
      AND char_length(btrim("cancelReasonText")) BETWEEN 1 AND 500))
    AND ("lateCancellation" IS NOT TRUE OR "cancelledByKind" <> 'CLINIC')
    AND ("status" = 'NO_SHOW' OR "noShowMarkedAt" IS NULL)
  ) NOT VALID;
-- Las filas existentes no tienen ninguno de estos datos: validar no cambia
-- nada, pero deja la restricción completa (también para las filas viejas).
-- Un CHECK ve todas las filas aunque la tabla tenga FORCE.
ALTER TABLE "appointments" VALIDATE CONSTRAINT "appointments_cancellation_check";

-- FK compuesta: la versión comunicada es de la MISMA clínica. Bajo NO FORCE
-- en la hija y en la referenciada (DX-134), FORCE de vuelta al final.
ALTER TABLE "appointments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_policy_version_fkey"
    FOREIGN KEY ("tenantId", "policyVersionId")
    REFERENCES "cancellation_policy_versions"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cancellation_policy_versions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
