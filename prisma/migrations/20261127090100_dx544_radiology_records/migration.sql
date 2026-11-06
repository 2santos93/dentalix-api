-- DX-544 (porción 1): expediente de rayos X de cada sede. Los documentos
-- regulatorios con vencimiento: la licencia de práctica (Categoría I o II) y
-- el informe de control de calidad de un tercero. Los plazos por defecto
-- viven en el código como valor propuesto (radiology-rules.ts); aquí solo se
-- guarda la fecha de vencimiento que quedó.
--
-- Cambios (todos ADITIVOS; el código anterior no lee ni escribe nada de esto):
--   "RadiologyRecordKind"        LICENSE | QUALITY_CONTROL.
--   "RadiologyLicenseCategory"   I | II (solo en una licencia).
--   equipment_tenant_location_id_key   índice ÚNICO (tenantId, locationId, id)
--       sobre equipment (DX-542): destino de la FK compuesta de abajo. Es
--       trivialmente único (id es la PK), así que no falla con datos.
--   radiology_records    un documento de una sede (obligatoria) y, si se
--       quiere, de un equipo de rayos X de ESA sede: tipo, categoría, número o
--       resolución, entidad emisora, expedición, vencimiento, encargado u
--       oficial de protección radiológica (un miembro del personal O un
--       nombre escrito) y notas. No se borra (sin DELETE para dentalix_app):
--       se anula con fecha, autor y motivo, una vez, y anulado ya no cambia
--       (trigger).
--
-- Reglas en la BD (la API responde antes con 400/404/409 en español; esto es
-- la red):
--   * FK COMPUESTAS por tenant (SEC-004), dentro del CREATE TABLE (la tabla
--     nace vacía, DX-134: ninguna FK se valida sobre filas existentes):
--       - (tenantId, locationId) → locations: la sede es de la MISMA clínica;
--       - (tenantId, locationId, equipmentId) → equipment(tenantId,
--         locationId, id): el equipo es de la MISMA clínica y de la MISMA SEDE
--         (con "equipmentId" NULL la FK no mira nada). ON UPDATE RESTRICT: un
--         equipo con documentos no se traslada de sede en silencio (la API de
--         equipos responde 409);
--       - (tenantId, officerMembershipId, officerUserId) →
--         clinic_memberships(tenantId, id, userId): el encargado es miembro de
--         la MISMA clínica y la membresía es la de ese usuario (patrón de
--         chairs_default_provider_fkey).
--   * CHECK: la categoría SOLO en una licencia (y obligatoria en ella), el
--     número obligatorio en una licencia, longitudes sin caracteres de
--     control, vencimiento posterior a la expedición y a 10 años como mucho,
--     encargado del personal O escrito (no los dos), anulación coherente.
--   * RLS FORCE por tenant con NULLIF (DX-251).
--
-- Índices: (tenantId, locationId, expiresOn, id) para la lista por sede y los
-- avisos de «Mi día» (también el lado hijo de la FK a la sede); lado hijo de
-- las FK al equipo, al encargado y a users.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya da a dentalix_app SELECT/INSERT/UPDATE
-- en las tablas nuevas; aquí se le quita DELETE y TRUNCATE.
--
-- Vuelta atrás (sin pérdida de datos de otras tablas): DROP TABLE
-- "radiology_records"; DROP FUNCTION "dx_radiology_records_voided_final"();
-- DROP INDEX "equipment_tenant_location_id_key"; DROP TYPE de los dos enums.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "RadiologyRecordKind" AS ENUM ('LICENSE', 'QUALITY_CONTROL');
CREATE TYPE "RadiologyLicenseCategory" AS ENUM ('I', 'II');

-- No concurrente: equipment es pequeña (DX-542) y el índice se construye en
-- lo que tarda en leerla; lock_timeout acota la espera del bloqueo.
CREATE UNIQUE INDEX "equipment_tenant_location_id_key"
  ON "equipment"("tenantId", "locationId", "id");

CREATE TABLE "radiology_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "equipmentId" UUID,
    "kind" "RadiologyRecordKind" NOT NULL,
    "category" "RadiologyLicenseCategory",
    "reference" VARCHAR(80),
    "issuer" VARCHAR(120) NOT NULL,
    "issuedOn" DATE NOT NULL,
    "expiresOn" DATE NOT NULL,
    "officerUserId" UUID,
    "officerMembershipId" UUID,
    "officerName" VARCHAR(120),
    "notes" TEXT,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,

    CONSTRAINT "radiology_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "radiology_records_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTA: la sede es de la MISMA clínica.
    CONSTRAINT "radiology_records_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTA: el equipo es de la MISMA clínica y de la MISMA sede.
    CONSTRAINT "radiology_records_equipment_fkey"
      FOREIGN KEY ("tenantId", "locationId", "equipmentId")
      REFERENCES "equipment"("tenantId", "locationId", "id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    -- FK COMPUESTA: el encargado es miembro de la MISMA clínica.
    CONSTRAINT "radiology_records_officer_fkey"
      FOREIGN KEY ("tenantId", "officerMembershipId", "officerUserId")
      REFERENCES "clinic_memberships"("tenantId", "id", "userId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "radiology_records_voided_by_fkey"
      FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- La categoría SOLO en una licencia, y obligatoria en ella.
    CONSTRAINT "radiology_records_category_check" CHECK (
      ("kind" = 'LICENSE' AND "category" IS NOT NULL)
      OR ("kind" = 'QUALITY_CONTROL' AND "category" IS NULL)
    ),
    CONSTRAINT "radiology_records_reference_check" CHECK (
      ("reference" IS NULL AND "kind" <> 'LICENSE')
      OR ("reference" IS NOT NULL
          AND "reference" = btrim("reference")
          AND char_length("reference") >= 1
          AND "reference" !~ '[[:cntrl:]]')
    ),
    CONSTRAINT "radiology_records_issuer_check" CHECK (
      "issuer" = btrim("issuer")
      AND char_length("issuer") BETWEEN 1 AND 120
      AND "issuer" !~ '[[:cntrl:]]'
    ),
    -- Posterior a la expedición y a 10 años como mucho (la API da el 400).
    CONSTRAINT "radiology_records_expires_check" CHECK (
      "expiresOn" > "issuedOn"
      AND "expiresOn" <= ("issuedOn" + interval '10 years')::date
    ),
    -- Del personal (usuario y membresía, juntos) O escrito; nunca los dos.
    CONSTRAINT "radiology_records_officer_check" CHECK (
      ("officerUserId" IS NULL) = ("officerMembershipId" IS NULL)
      AND ("officerUserId" IS NULL OR "officerName" IS NULL)
      AND ("officerName" IS NULL OR (
            "officerName" = btrim("officerName")
            AND char_length("officerName") >= 1
            AND "officerName" !~ '[[:cntrl:]]'))
    ),
    CONSTRAINT "radiology_records_notes_check" CHECK (
      "notes" IS NULL OR char_length("notes") <= 2000
    ),
    -- ANULADO <=> fecha, autor y motivo. IS NOT NULL explícito: con NULL,
    -- char_length(...) da NULL y un CHECK con NULL PASA.
    CONSTRAINT "radiology_records_void_check" CHECK (
      ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
      OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL
          AND "voidReason" IS NOT NULL
          AND char_length(btrim("voidReason")) BETWEEN 3 AND 500)
    )
);

-- Lista por sede por vencimiento y avisos de «Mi día»; también el lado hijo
-- de la FK a la sede.
CREATE INDEX "radiology_records_tenant_location_expires_idx"
  ON "radiology_records"("tenantId", "locationId", "expiresOn", "id");
-- Lado hijo de las FK al equipo, al encargado y a users.
CREATE INDEX "radiology_records_equipment_idx"
  ON "radiology_records"("tenantId", "locationId", "equipmentId");
CREATE INDEX "radiology_records_officer_idx"
  ON "radiology_records"("tenantId", "officerMembershipId", "officerUserId");
CREATE INDEX "radiology_records_voided_by_idx" ON "radiology_records"("voidedById");

-- Un documento anulado ya no cambia (ni se «desanula»). search_path fijo con
-- pg_temp AL FINAL y catálogo calificado (SEC-032).
CREATE FUNCTION "dx_radiology_records_voided_final"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD."voidedAt" IS NOT NULL
     AND (pg_catalog.to_jsonb(NEW) - 'updatedAt')
         IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'updatedAt')
  THEN
    RAISE EXCEPTION 'radiology_records: un documento anulado no se modifica (DX-544)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "radiology_records_voided_final"
  BEFORE UPDATE ON "radiology_records"
  FOR EACH ROW EXECUTE FUNCTION "dx_radiology_records_voided_final"();

ALTER TABLE "radiology_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "radiology_records" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "radiology_records"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Anular en lugar de borrar: la app no borra documentos del expediente.
REVOKE DELETE, TRUNCATE ON "radiology_records" FROM dentalix_app;
GRANT SELECT, INSERT, UPDATE ON "radiology_records" TO dentalix_app;
