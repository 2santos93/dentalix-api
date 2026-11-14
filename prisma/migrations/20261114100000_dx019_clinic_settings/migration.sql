-- DX-019: ajustes de la clínica (Ajustes › Datos de la clínica, solo ADMIN).
-- Datos fiscales y de contacto que imprimen el recibo, el presupuesto, la
-- receta y el estado de cuenta, y la clave del logo subido. Todos opcionales y
-- SIN formato por país:
--
--   tenants."legalName"      razón social. 1..160.
--   tenants."taxId"          identificador fiscal, texto libre (nada de
--                            validar un formato nacional). 1..64.
--   tenants."taxIdLabel"     cómo lo llama la clínica («ID fiscal», …). NULL =
--                            el genérico «Id. fiscal» (lo pone la web). 1..40.
--   tenants."fiscalAddress"  dirección fiscal. 1..250, una línea.
--   tenants."contactEmail"   email de contacto de la clínica. 3..254.
--   tenants."contactPhone"   teléfono de contacto, texto libre. 1..40.
--
-- El logo usa la columna existente "logoUrl", que pasa a guardar la CLAVE del
-- almacén (DX-084, como `users."avatarUrl"`); ver `clinicLogoPublicUrl`.
--
-- Sin razón social o sin identificador, el recibo dice «Datos fiscales
-- pendientes» (DX-136). Los recibos emitidos CONGELAN estos datos en su foto:
-- cambiarlos no reescribe ninguno.
--
-- Textos: sin espacios en los extremos y sin caracteres de control (una
-- línea). La API responde antes con 400 en español; el CHECK es la red.
--
-- Expand puro: columnas NULL (PG 16 solo toca el catálogo); los CHECK se
-- validan en la misma sentencia (todas las filas a NULL; `tenants` es
-- pequeña). Una réplica anterior que inserta sin nombrar las columnas recibe
-- NULL, que es «sin configurar». `tenants` no tiene RLS; las columnas heredan
-- el grant de la tabla a dentalix_app. Sin fechas: sin trigger UTC.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants"
  ADD COLUMN "legalName" TEXT,
  ADD COLUMN "taxId" TEXT,
  ADD COLUMN "taxIdLabel" TEXT,
  ADD COLUMN "fiscalAddress" TEXT,
  ADD COLUMN "contactEmail" TEXT,
  ADD COLUMN "contactPhone" TEXT,
  ADD CONSTRAINT "tenants_legal_name_check" CHECK (
    "legalName" IS NULL OR (
      char_length("legalName") BETWEEN 1 AND 160
      AND "legalName" = btrim("legalName")
      AND "legalName" !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT "tenants_tax_id_check" CHECK (
    "taxId" IS NULL OR (
      char_length("taxId") BETWEEN 1 AND 64
      AND "taxId" = btrim("taxId")
      AND "taxId" !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT "tenants_tax_id_label_check" CHECK (
    "taxIdLabel" IS NULL OR (
      char_length("taxIdLabel") BETWEEN 1 AND 40
      AND "taxIdLabel" = btrim("taxIdLabel")
      AND "taxIdLabel" !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT "tenants_fiscal_address_check" CHECK (
    "fiscalAddress" IS NULL OR (
      char_length("fiscalAddress") BETWEEN 1 AND 250
      AND "fiscalAddress" = btrim("fiscalAddress")
      AND "fiscalAddress" !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT "tenants_contact_email_check" CHECK (
    "contactEmail" IS NULL OR (
      char_length("contactEmail") BETWEEN 3 AND 254
      AND "contactEmail" ~ '^[^[:space:]@]+@[^[:space:]@]+$'
    )
  ),
  ADD CONSTRAINT "tenants_contact_phone_check" CHECK (
    "contactPhone" IS NULL OR (
      char_length("contactPhone") BETWEEN 1 AND 40
      AND "contactPhone" = btrim("contactPhone")
      AND "contactPhone" !~ '[[:cntrl:]]'
    )
  );

-- DX-019 (médico-legal): la receta congela los datos fiscales de la clínica al
-- emitirse, como el recibo. Objeto jsonb; NULL = emitida antes o sin datos: se
-- reimprime SIN datos fiscales, nunca con los de hoy. La protege el trigger
-- `prescriptions_immutable` (compara la fila entera) y entra en el hash (v4).
ALTER TABLE "prescriptions"
  ADD COLUMN "clinicFiscal" JSONB,
  ADD CONSTRAINT "prescriptions_clinic_fiscal_check" CHECK (
    "clinicFiscal" IS NULL OR jsonb_typeof("clinicFiscal") = 'object'
  ) NOT VALID;
