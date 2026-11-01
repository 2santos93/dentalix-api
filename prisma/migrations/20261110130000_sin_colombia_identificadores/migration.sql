-- Excepción G5.3 (DX-334): última migración que nombra los códigos
-- anteriores a DX-326 y DX-327, para retirarlos.
--
-- Sin Colombia (DX-323): ningún identificador interno de la BD conserva un
-- nombre de un país. Fase 2 de DX-326 y DX-327, y renombrado de las columnas
-- de la aseguradora antigua de DX-153. NADA SE BORRA: cada valor guardado se
-- traduce o se renombra.
--
-- 1. "PayerType": se queda con los cinco genéricos. Cada pagador con un código
--    anterior pasa a su genérico con la tabla biyectiva de DX-326
--    (MUTUA_ES→INSURER, PREPAGADA_CO→PREPAID_PLAN, EPS_CO→PUBLIC_SYSTEM,
--    EMPRESA→EMPLOYER, OTRO→OTHER), que es lo que la API ya mostraba. Un enum
--    no pierde valores con ALTER TYPE: se crea el nuevo, la columna cambia de
--    tipo con USING (reescribe `payers`, tabla pequeña, ACCESS EXCLUSIVE breve)
--    y el viejo se borra. Ninguna función, vista, índice ni política usa el
--    tipo ni la columna.
--
-- 2. Código de documento anterior a DX-327 ("docType", enum "DocType"): la API
--    ya no lo lee ni lo escribe. Se retiran el trigger *_document_type y las
--    cuatro funciones dx_doc_type_* / dx_document_type_sync que lo mantenían
--    para las réplicas anteriores. La columna NO se borra: es el único sitio
--    que distingue el documento de un menor del de un adulto en las filas
--    anteriores (los dos son NATIONAL_ID). Se renombra a "legacyDocumentCode"
--    con un enum "LegacyDocumentCode" de valores genéricos (RENAME VALUE: cada
--    fila conserva su valor, sin reescribir la tabla):
--      CC → NATIONAL_ID, TI → MINOR_ID, CE → FOREIGNER_ID,
--      PASSPORT y OTHER sin cambio.
--    Queda congelada: sin DEFAULT y nullable, NULL en las filas nuevas. El
--    CHECK patient_responsible_parties_kind_check la sigue nombrando (el
--    renombrado de columna lo actualiza solo).
--
-- 3. patients."insurerEps" (texto libre anterior a DX-153, ya copiado a
--    coberturas) → "legacyInsurerName"; patient_coverages."migratedFromInsurerEps"
--    → "migratedFromLegacyInsurer". RENAME COLUMN no toca filas; el índice
--    parcial patient_coverages_migrated_key se actualiza solo.
--
-- Despliegue: cambia el contrato (`migratedFromLegacyInsurer`) y una réplica
-- anterior de la API falla al leer coberturas o al guardar un pagador; web y
-- API se despliegan juntas, sin réplicas anteriores vivas.
--
-- RLS FORCE no se toca. lock_timeout 5 s: si una transacción larga retiene una
-- tabla, falla limpia; para reintentar, `npx prisma migrate resolve
-- --rolled-back 20261110130000_sin_colombia_identificadores` y de nuevo el deploy.

SET LOCAL lock_timeout = '5s';

-- 1. Tipos de pagador ---------------------------------------------------------

CREATE TYPE "PayerType_generic" AS ENUM ('INSURER', 'PREPAID_PLAN', 'PUBLIC_SYSTEM', 'EMPLOYER', 'OTHER');

ALTER TABLE "payers"
  ALTER COLUMN "type" TYPE "PayerType_generic"
  USING (
    CASE "type"::text
      WHEN 'MUTUA_ES' THEN 'INSURER'
      WHEN 'PREPAGADA_CO' THEN 'PREPAID_PLAN'
      WHEN 'EPS_CO' THEN 'PUBLIC_SYSTEM'
      WHEN 'EMPRESA' THEN 'EMPLOYER'
      WHEN 'OTRO' THEN 'OTHER'
      ELSE "type"::text
    END
  )::"PayerType_generic";

DROP TYPE "PayerType";
ALTER TYPE "PayerType_generic" RENAME TO "PayerType";

-- 2. Código de documento anterior ---------------------------------------------

DROP TRIGGER "patients_document_type" ON "patients";
DROP TRIGGER "patient_responsible_parties_document_type" ON "patient_responsible_parties";
DROP FUNCTION public.dx_document_type_sync();
DROP FUNCTION public.dx_doc_type_coherent(public."DocType", public."DocumentType");
DROP FUNCTION public.dx_doc_type_to_legacy(public."DocumentType");
DROP FUNCTION public.dx_doc_type_from_legacy(public."DocType");

ALTER TYPE "DocType" RENAME VALUE 'CC' TO 'NATIONAL_ID';
ALTER TYPE "DocType" RENAME VALUE 'TI' TO 'MINOR_ID';
ALTER TYPE "DocType" RENAME VALUE 'CE' TO 'FOREIGNER_ID';
ALTER TYPE "DocType" RENAME TO "LegacyDocumentCode";

ALTER TABLE "patients" RENAME COLUMN "docType" TO "legacyDocumentCode";
ALTER TABLE "patients"
  ALTER COLUMN "legacyDocumentCode" DROP DEFAULT,
  ALTER COLUMN "legacyDocumentCode" DROP NOT NULL;

ALTER TABLE "patient_responsible_parties" RENAME COLUMN "docType" TO "legacyDocumentCode";

-- 3. Aseguradora antigua -------------------------------------------------------

ALTER TABLE "patients" RENAME COLUMN "insurerEps" TO "legacyInsurerName";
ALTER TABLE "patient_coverages" RENAME COLUMN "migratedFromInsurerEps" TO "migratedFromLegacyInsurer";
