-- DX-330 (epic DX-311 «Producto global, sin supuestos de país»): el plazo de
-- conservación de la historia clínica es un ajuste de la clínica, con un
-- mínimo de plataforma de 15 años. Hasta ahora era una constante de código
-- (CLINICAL_RECORD_RETENTION_YEARS) igual para todas.
--
-- Expand, solo `tenants`: tres columnas y dos CHECK.
--   - `clinicalRecordRetentionYears`: NOT NULL con el default de plataforma
--     (15), CHECK de límites (15..100). El default ES el relleno (todas las
--     clínicas existentes quedan en 15, el plazo que ya aplicaba el código),
--     así que no hay ventana con NULL ni fase 2.
--   - `clinicalRecordRetentionRaisedAt` y `clinicalRecordRetentionYearsBeforeRaise`:
--     la ventana de corrección de 24 h tras una subida (R13). Nullable y sin
--     default: solo catálogo. El segundo CHECK exige las dos o ninguna, y se
--     valida con todas a NULL. El `IS NOT NULL` explícito del año anterior
--     importa: `NULL BETWEEN 15 AND 100` es NULL y un CHECK deja pasar NULL.
--   - En PG 16, ADD COLUMN con un DEFAULT constante y NOT NULL solo toca el
--     catálogo (attmissingval): no reescribe la tabla.
--   - Los CHECK se validan en la misma sentencia, bajo el ACCESS EXCLUSIVE
--     que ya toma el ADD COLUMN. `tenants` tiene una fila por clínica: son
--     milisegundos, así que no se separa en NOT VALID + VALIDATE. Es el mismo
--     razonamiento de 20261028160200_dx328_tenant_majority_age.
--   - Una réplica anterior que crea una clínica sin nombrar la columna recibe
--     15, lo mismo que la API nueva escribe explícito (mínimo de plataforma).
--     Las réplicas anteriores no leen la columna.
--
-- Sin relleno, así que no hace falta `row_security = off`.
--
-- lock_timeout 5 s, como DX-247 y DX-328 en esta misma tabla: toda petición
-- lee `tenants` al resolver la clínica, así que mientras este ALTER espera su
-- bloqueo los lectores nuevos hacen cola detrás. Si falla, se reintenta el
-- deploy.
--
-- Grants: no aplica (`tenants` ya concedida a dentalix_app; columnas nuevas
-- de tabla existente). RLS: no hay tabla nueva.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants"
  ADD COLUMN "clinicalRecordRetentionYears" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "clinicalRecordRetentionRaisedAt" TIMESTAMP(3),
  ADD COLUMN "clinicalRecordRetentionYearsBeforeRaise" INTEGER,
  ADD CONSTRAINT "tenants_clinical_record_retention_years_check"
    CHECK ("clinicalRecordRetentionYears" BETWEEN 15 AND 100),
  ADD CONSTRAINT "tenants_clinical_record_retention_raise_check"
    CHECK (
      ("clinicalRecordRetentionRaisedAt" IS NULL AND "clinicalRecordRetentionYearsBeforeRaise" IS NULL)
      OR ("clinicalRecordRetentionRaisedAt" IS NOT NULL
          AND "clinicalRecordRetentionYearsBeforeRaise" IS NOT NULL
          AND "clinicalRecordRetentionYearsBeforeRaise" BETWEEN 15 AND 100)
    );
