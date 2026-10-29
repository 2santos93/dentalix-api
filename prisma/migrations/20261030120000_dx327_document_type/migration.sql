-- Excepción G5.3 (DX-334): tipos de documento anteriores a DX-327.
--
-- DX-327 (epic DX-311 «Producto global, sin supuestos de país»), fase 1:
-- tipo de documento del paciente genérico en una columna propia.
--
-- "documentType" (enum nuevo "DocumentType") y "docTypeLabel" (nombre libre
-- que escribe la clínica) van junto a la columna de siempre, "docType". La
-- API nueva solo lee las columnas nuevas; la antigua se queda para las
-- réplicas anteriores, que no conocen las nuevas (Prisma no selecciona
-- columnas que no están en su esquema) y que solo saben leer los códigos
-- antiguos. El trigger *_document_type mantiene la pareja coherente en los
-- dos sentidos. Por eso el enum "DocType" no cambia: un valor nuevo en esa
-- columna daría 500 a una réplica anterior en la lista de pacientes, y
-- TAX_ID no tiene código antiguo. La fase 2 (ticket aparte) borra el
-- trigger, las funciones, la columna y el enum antiguos.
--
-- Correspondencia fija (src/modules/patients/domain/legacy-doc-type.ts):
--   CC       → NATIONAL_ID        NATIONAL_ID      → CC
--   TI       → NATIONAL_ID
--   CE       → RESIDENCE_PERMIT   RESIDENCE_PERMIT → CE
--   PASSPORT → PASSPORT           PASSPORT         → PASSPORT
--   OTHER    → OTHER              OTHER, TAX_ID    → OTHER
-- Ningún código antiguo da etiqueta: ninguna migración de DX-327 escribe
-- "docTypeLabel" y el trigger solo la conserva o la pone a NULL.
--
-- Las filas existentes nacen con el DEFAULT 'OTHER' (sin reescribir la
-- tabla); el relleno por lotes es 20261030120100 y la validación
-- 20261030120200. Los CHECK van NOT VALID aquí y se validan allí.
--
-- ADD COLUMN y CREATE TRIGGER toman un ACCESS EXCLUSIVE breve sobre
-- patients y patient_responsible_parties, sin leer la tabla. lock_timeout
-- 5 s: si una transacción larga lo retiene, falla limpia; para reintentar,
-- `npx prisma migrate resolve --rolled-back 20261030120000_dx327_document_type`
-- y de nuevo el deploy. RLS FORCE no se toca.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "DocumentType" AS ENUM ('NATIONAL_ID', 'PASSPORT', 'RESIDENCE_PERMIT', 'TAX_ID', 'OTHER');

-- Código antiguo → tipo genérico.
CREATE FUNCTION public.dx_doc_type_from_legacy(legacy public."DocType")
RETURNS public."DocumentType"
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE legacy
    WHEN 'CC'::public."DocType" THEN 'NATIONAL_ID'::public."DocumentType"
    WHEN 'TI'::public."DocType" THEN 'NATIONAL_ID'::public."DocumentType"
    WHEN 'CE'::public."DocType" THEN 'RESIDENCE_PERMIT'::public."DocumentType"
    WHEN 'PASSPORT'::public."DocType" THEN 'PASSPORT'::public."DocumentType"
    WHEN 'OTHER'::public."DocType" THEN 'OTHER'::public."DocumentType"
  END
$$;

-- Tipo genérico → código antiguo que se guarda para las réplicas anteriores.
CREATE FUNCTION public.dx_doc_type_to_legacy(generic public."DocumentType")
RETURNS public."DocType"
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE generic
    WHEN 'NATIONAL_ID'::public."DocumentType" THEN 'CC'::public."DocType"
    WHEN 'PASSPORT'::public."DocumentType" THEN 'PASSPORT'::public."DocType"
    WHEN 'RESIDENCE_PERMIT'::public."DocumentType" THEN 'CE'::public."DocType"
    WHEN 'TAX_ID'::public."DocumentType" THEN 'OTHER'::public."DocType"
    WHEN 'OTHER'::public."DocumentType" THEN 'OTHER'::public."DocType"
  END
$$;

-- La pareja es coherente si el antiguo es la proyección del genérico o el
-- genérico es la traducción del antiguo: TI + NATIONAL_ID y OTHER + TAX_ID
-- lo son. Los dos NULL también.
CREATE FUNCTION public.dx_doc_type_coherent(
  legacy public."DocType",
  generic public."DocumentType"
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT legacy IS NOT DISTINCT FROM public.dx_doc_type_to_legacy(generic)
      OR public.dx_doc_type_from_legacy(legacy) IS NOT DISTINCT FROM generic
$$;

-- El escritor anterior nunca da "documentType" (no conoce la columna); la
-- API nueva siempre lo da. Casos en la spec de DX-327, §3.3.
CREATE FUNCTION public.dx_document_type_sync() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."docType" IS NULL AND NEW."documentType" IS NOT NULL THEN
      -- 1. Escritor nuevo que no dio el antiguo (responsables).
      NEW."docType" := public.dx_doc_type_to_legacy(NEW."documentType");
    ELSIF public.dx_doc_type_coherent(NEW."docType", NEW."documentType") THEN
      -- 2. Escritor nuevo que escribió la pareja, o los dos NULL.
      NULL;
    ELSIF NEW."documentType" IS NULL OR NEW."documentType" = 'OTHER' THEN
      -- 3. Escritor anterior (DEFAULT 'OTHER' o NULL): manda el antiguo. La
      -- etiqueta no se toca: el escritor anterior no la conoce.
      NEW."documentType" := public.dx_doc_type_from_legacy(NEW."docType");
    ELSE
      -- 4. Manda el nuevo.
      NEW."docType" := public.dx_doc_type_to_legacy(NEW."documentType");
    END IF;
  ELSIF NEW."documentType" IS DISTINCT FROM OLD."documentType" THEN
    -- 1. Cambia el genérico (escritor nuevo o relleno): el antiguo se ajusta
    -- solo si la pareja queda incoherente (un TI sigue TI con NATIONAL_ID).
    -- La etiqueta la decide la API, salvo que el tipo desaparezca.
    IF NOT public.dx_doc_type_coherent(NEW."docType", NEW."documentType") THEN
      NEW."docType" := public.dx_doc_type_to_legacy(NEW."documentType");
    END IF;
    IF NEW."documentType" IS NULL THEN
      NEW."docTypeLabel" := NULL;
    END IF;
  ELSIF NEW."docType" IS DISTINCT FROM OLD."docType" THEN
    -- 2. Cambia solo el antiguo (escritor anterior). Si con eso cambia el
    -- genérico, la etiqueta de un tipo no vale para otro.
    NEW."documentType" := public.dx_doc_type_from_legacy(NEW."docType");
    IF NEW."documentType" IS DISTINCT FROM OLD."documentType"
       OR NEW."documentType" IS NULL THEN
      NEW."docTypeLabel" := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "patients"
  ADD COLUMN "documentType" "DocumentType" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "docTypeLabel" TEXT;

ALTER TABLE "patients"
  ADD CONSTRAINT "patients_doc_type_label_check" CHECK (
    "docTypeLabel" IS NULL
    OR (char_length("docTypeLabel") BETWEEN 1 AND 40
        AND "docTypeLabel" = btrim("docTypeLabel"))
  ) NOT VALID;

CREATE TRIGGER "patients_document_type"
  BEFORE INSERT OR UPDATE OF "docType", "documentType" ON "patients"
  FOR EACH ROW EXECUTE FUNCTION public.dx_document_type_sync();

-- Responsables: nullable y sin default (un responsable que es paciente no
-- tiene tipo; un contacto puede no tenerlo).
ALTER TABLE "patient_responsible_parties"
  ADD COLUMN "documentType" "DocumentType",
  ADD COLUMN "docTypeLabel" TEXT;

ALTER TABLE "patient_responsible_parties"
  ADD CONSTRAINT "patient_responsible_parties_doc_type_label_check" CHECK (
    "docTypeLabel" IS NULL
    OR (char_length("docTypeLabel") BETWEEN 1 AND 40
        AND "docTypeLabel" = btrim("docTypeLabel"))
  ) NOT VALID;

-- Un responsable que es paciente no tiene tipo ni etiqueta; una etiqueta
-- exige un tipo.
ALTER TABLE "patient_responsible_parties"
  ADD CONSTRAINT "patient_responsible_parties_document_type_check" CHECK (
    ("responsiblePatientId" IS NULL
      OR ("documentType" IS NULL AND "docTypeLabel" IS NULL))
    AND ("docTypeLabel" IS NULL OR "documentType" IS NOT NULL)
  ) NOT VALID;

CREATE TRIGGER "patient_responsible_parties_document_type"
  BEFORE INSERT OR UPDATE OF "docType", "documentType" ON "patient_responsible_parties"
  FOR EACH ROW EXECUTE FUNCTION public.dx_document_type_sync();
