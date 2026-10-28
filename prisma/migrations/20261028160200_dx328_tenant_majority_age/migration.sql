-- DX-328 (epic DX-311 «Producto global, sin supuestos de país»): la mayoría
-- de edad es un ajuste de la clínica. Es la edad desde la que el paciente es
-- adulto: sus avisos y documentos de cobro van a él y la ficha deja de pedir
-- responsable. Hasta ahora salía del país de la sede.
--
-- Expand, solo `tenants`: columna NOT NULL con el default de plataforma (18)
-- y su CHECK de límites (14..21).
--   - En PG 16, ADD COLUMN con un DEFAULT constante y NOT NULL solo toca el
--     catálogo (attmissingval): no reescribe la tabla.
--   - El CHECK se valida en la misma sentencia, bajo el ACCESS EXCLUSIVE que
--     ya toma el ADD COLUMN. `tenants` tiene una fila por clínica: son
--     milisegundos, así que no se separa en NOT VALID + VALIDATE.
--   - Una réplica anterior que crea una clínica sin nombrar la columna recibe
--     18, lo mismo que la API nueva escribe explícito
--     (PLATFORM_DEFAULT_MAJORITY_AGE). Las réplicas anteriores no leen la
--     columna.
--
-- Relleno en la migración siguiente
-- (20261028160300_dx328_tenant_majority_age_backfill), en otra transacción:
-- así esta no retiene `tenants` mientras espera el bloqueo de `locations`
-- (pre-flight I1). Ningún código lee aún la columna, así que nadie ve el 18
-- transitorio entre las dos.
--
-- Sin fase 2: la columna nace NOT NULL y nunca hay un NULL que barrer (ver
-- spec G2G3 §4.1).
--
-- Grants: no aplica (`tenants` ya concedida a dentalix_app; columna nueva de
-- tabla existente).

SET LOCAL lock_timeout = '10s';

ALTER TABLE "tenants"
  ADD COLUMN "majorityAge" INTEGER NOT NULL DEFAULT 18,
  ADD CONSTRAINT "tenants_majority_age_check"
    CHECK ("majorityAge" BETWEEN 14 AND 21);
