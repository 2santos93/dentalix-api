-- DX-524 (epic DX-311 «Producto global, sin supuestos de país»): la sede puede
-- poner su propio nombre a cada tipo de documento (DX-327 los guarda solo por
-- clínica). NULL = hereda el de la clínica y, sin este, el genérico.
--
-- Sin relleno: todas las sedes, las de hoy y las nuevas, empiezan con los cinco
-- a NULL, así que nada cambia hasta que un ADMIN escribe uno (PATCH
-- /locations/:id, auditado). Ningún valor por defecto de país.
--
-- Expand puro: cinco columnas nullable sin default (solo catálogo) y CHECK como
-- los de `tenants` (1..60, sin espacios en los extremos). `locations` es
-- pequeña y todas sus filas tienen NULL: los CHECK se crean ya validados.
-- Una réplica anterior no conoce las columnas y no las selecciona. La
-- unicidad entre tipos la comprueba la API (necesita la clave de comparación).
--
-- Grants: no aplica (`locations` ya concedida a dentalix_app). RLS y FORCE no
-- cambian.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "locations"
  ADD COLUMN "docTypeNameNationalId" TEXT,
  ADD COLUMN "docTypeNamePassport" TEXT,
  ADD COLUMN "docTypeNameResidencePermit" TEXT,
  ADD COLUMN "docTypeNameTaxId" TEXT,
  ADD COLUMN "docTypeNameOther" TEXT,
  ADD CONSTRAINT "locations_doc_type_name_national_id_check"
    CHECK ("docTypeNameNationalId" IS NULL OR (char_length("docTypeNameNationalId") BETWEEN 1 AND 60 AND "docTypeNameNationalId" = btrim("docTypeNameNationalId"))),
  ADD CONSTRAINT "locations_doc_type_name_passport_check"
    CHECK ("docTypeNamePassport" IS NULL OR (char_length("docTypeNamePassport") BETWEEN 1 AND 60 AND "docTypeNamePassport" = btrim("docTypeNamePassport"))),
  ADD CONSTRAINT "locations_doc_type_name_residence_permit_check"
    CHECK ("docTypeNameResidencePermit" IS NULL OR (char_length("docTypeNameResidencePermit") BETWEEN 1 AND 60 AND "docTypeNameResidencePermit" = btrim("docTypeNameResidencePermit"))),
  ADD CONSTRAINT "locations_doc_type_name_tax_id_check"
    CHECK ("docTypeNameTaxId" IS NULL OR (char_length("docTypeNameTaxId") BETWEEN 1 AND 60 AND "docTypeNameTaxId" = btrim("docTypeNameTaxId"))),
  ADD CONSTRAINT "locations_doc_type_name_other_check"
    CHECK ("docTypeNameOther" IS NULL OR (char_length("docTypeNameOther") BETWEEN 1 AND 60 AND "docTypeNameOther" = btrim("docTypeNameOther")));
