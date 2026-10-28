-- DX-324 (epic DX-311 «Producto global, sin supuestos de país»): tres ajustes
-- de la receta por clínica, iguales en todas sus sedes:
--   - "prescriptionPrintQuantityInWords": la receta imprime la cantidad de
--     cada medicamento también en letras;
--   - "prescriptionRequireClinicalRecordNumber": no se emite sin documento
--     del paciente, que la receta imprime como nº de historia clínica;
--   - "prescriptionValidityDays": días que vale la receta desde su fecha de
--     inicio, de 1 a 365.
--
-- Expand, solo `tenants`: columnas NOT NULL con los defaults de plataforma
-- (false, false y 30, PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS).
--   - En PG 16, ADD COLUMN con un DEFAULT constante y NOT NULL solo toca el
--     catálogo (attmissingval): no reescribe la tabla.
--   - El CHECK se valida en la misma sentencia, bajo el ACCESS EXCLUSIVE que
--     ya toma el ADD COLUMN. `tenants` tiene una fila por clínica: son
--     milisegundos, así que no se separa en NOT VALID + VALIDATE (como
--     DX-328).
--   - Una réplica anterior que crea una clínica sin nombrar las columnas
--     recibe los defaults, lo mismo que la API nueva escribe explícito. Las
--     réplicas anteriores no las leen.
--
-- Relleno en la migración siguiente
-- (20261028180400_dx324_tenant_prescription_settings_backfill), en otra
-- transacción: así esta no retiene `tenants` mientras espera el bloqueo de
-- `locations`. Ningún código lee aún las columnas, así que nadie ve los
-- defaults transitorios entre las dos.
--
-- lock_timeout 5 s, como DX-247 y DX-328 en esta misma tabla: toda petición
-- lee `tenants` al resolver la clínica, así que mientras este ALTER espera su
-- bloqueo los lectores nuevos hacen cola detrás. Si falla, se reintenta el
-- deploy.
--
-- Sin trigger UTC (DX-226): no hay columnas de fecha. Grants: no aplica
-- (`tenants` ya concedida a dentalix_app; columnas nuevas de tabla existente).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants"
  ADD COLUMN "prescriptionPrintQuantityInWords" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "prescriptionRequireClinicalRecordNumber" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "prescriptionValidityDays" INTEGER NOT NULL DEFAULT 30,
  ADD CONSTRAINT "tenants_prescription_validity_days_check"
    CHECK ("prescriptionValidityDays" BETWEEN 1 AND 365);
