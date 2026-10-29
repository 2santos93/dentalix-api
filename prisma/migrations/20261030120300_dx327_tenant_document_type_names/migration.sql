-- DX-327 (epic DX-311 «Producto global, sin supuestos de país»), R16: nombre
-- local de cada tipo de documento genérico, por clínica. NULL = la clínica
-- usa el nombre genérico. Lo cambia el ADMIN (PUT
-- /patients/document-type-names, auditado).
--
-- Sin relleno: todas las clínicas, las de hoy y las nuevas, empiezan con los
-- cinco a NULL. Ningún valor por defecto de país; ninguna siembra los
-- rellena (tampoco la demo).
--
-- Cinco columnas nullable sin default: ADD COLUMN solo toca el catálogo, sin
-- reescribir la tabla. Los CHECK van NOT VALID y se validan aquí mismo: todas
-- las filas tienen NULL, así que VALIDATE no encuentra nada que rechazar.
-- La unicidad entre tipos (R16) la comprueba la API, que necesita la clave
-- de comparación y los nombres genéricos; el PUT sustituye los cinco en un
-- solo UPDATE.
--
-- ACCESS EXCLUSIVE breve sobre `tenants`, que casi toda petición lee al
-- resolver la clínica: lock_timeout 5 s, como DX-328 en esta misma tabla. Si
-- falla, `npx prisma migrate resolve --rolled-back
-- 20261030120300_dx327_tenant_document_type_names` y de nuevo el deploy.
-- Una réplica anterior no conoce las columnas y no las selecciona.
--
-- Grants: no aplica (`tenants` ya concedida a dentalix_app; columnas nuevas
-- de tabla existente). `tenants` no tiene RLS: FORCE no cambia.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants"
  ADD COLUMN "docTypeNameNationalId" TEXT,
  ADD COLUMN "docTypeNamePassport" TEXT,
  ADD COLUMN "docTypeNameResidencePermit" TEXT,
  ADD COLUMN "docTypeNameTaxId" TEXT,
  ADD COLUMN "docTypeNameOther" TEXT;

ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_doc_type_name_national_id_check"
    CHECK ("docTypeNameNationalId" IS NULL OR (char_length("docTypeNameNationalId") BETWEEN 1 AND 60 AND "docTypeNameNationalId" = btrim("docTypeNameNationalId"))) NOT VALID,
  ADD CONSTRAINT "tenants_doc_type_name_passport_check"
    CHECK ("docTypeNamePassport" IS NULL OR (char_length("docTypeNamePassport") BETWEEN 1 AND 60 AND "docTypeNamePassport" = btrim("docTypeNamePassport"))) NOT VALID,
  ADD CONSTRAINT "tenants_doc_type_name_residence_permit_check"
    CHECK ("docTypeNameResidencePermit" IS NULL OR (char_length("docTypeNameResidencePermit") BETWEEN 1 AND 60 AND "docTypeNameResidencePermit" = btrim("docTypeNameResidencePermit"))) NOT VALID,
  ADD CONSTRAINT "tenants_doc_type_name_tax_id_check"
    CHECK ("docTypeNameTaxId" IS NULL OR (char_length("docTypeNameTaxId") BETWEEN 1 AND 60 AND "docTypeNameTaxId" = btrim("docTypeNameTaxId"))) NOT VALID,
  ADD CONSTRAINT "tenants_doc_type_name_other_check"
    CHECK ("docTypeNameOther" IS NULL OR (char_length("docTypeNameOther") BETWEEN 1 AND 60 AND "docTypeNameOther" = btrim("docTypeNameOther"))) NOT VALID;

ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_doc_type_name_national_id_check";
ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_doc_type_name_passport_check";
ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_doc_type_name_residence_permit_check";
ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_doc_type_name_tax_id_check";
ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_doc_type_name_other_check";
