-- DX-562: citas en serie («cada N semanas, N veces o hasta una fecha»).
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   appointment_series     la serie: intervalo en semanas (1–12), citas que
--                          se crearon (1–26), quién y cuándo la creó y, si
--                          cancelar «esta y las siguientes» no dejó ninguna
--                          pendiente, cuándo y quién (los dos o ninguno). SIN
--                          paciente ni profesional (salen de sus citas): no
--                          entra en dx_patient_merge_tables ni en la
--                          importación de pacientes. FK directa a tenants con
--                          RESTRICT; destino (tenantId, id) de la FK compuesta
--                          de appointments. RLS ENABLE + FORCE con la política
--                          NULLIF (DX-251). Sin DELETE para la app.
--   appointments."seriesId", "seriesIndex"
--                          columnas NULL sin DEFAULT (instantáneas: no
--                          reescriben la tabla). CHECK «las dos o ninguna» y
--                          posición 1–26, y FK compuesta (tenantId, seriesId)
--                          → appointment_series RESTRICT, ambas NOT VALID: su
--                          VALIDATE va en 20270116140300. El índice (lado hijo
--                          de la FK) va CONCURRENTLY en 20270116140200.
--
-- FK sobre tablas con RLS FORCE (DX-134): las de la tabla nueva van DENTRO del
-- CREATE TABLE (nace vacía: la validación no lee filas). La de appointments
-- se añade NOT VALID (solo vale para las filas nuevas o modificadas) y se
-- valida con NO FORCE en su propia migración.
--
-- Vuelta atrás: desplegar la API anterior y
--   ALTER TABLE public."appointments"
--     DROP CONSTRAINT "appointments_series_fkey",
--     DROP CONSTRAINT "appointments_series_check",
--     DROP COLUMN "seriesIndex", DROP COLUMN "seriesId";
--   DROP TABLE public."appointment_series";
-- (el índice appointments_tenant_series_index_key se va con la columna).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- appointment_series
-- ---------------------------------------------------------------------------

CREATE TABLE "appointment_series" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "intervalWeeks" SMALLINT NOT NULL,
    "occurrences" SMALLINT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" UUID,

    CONSTRAINT "appointment_series_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "appointment_series_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "appointment_series_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "appointment_series_cancelled_by_fkey"
      FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "appointment_series_interval_check"
      CHECK ("intervalWeeks" BETWEEN 1 AND 12),
    CONSTRAINT "appointment_series_occurrences_check"
      CHECK ("occurrences" BETWEEN 1 AND 26),
    CONSTRAINT "appointment_series_cancelled_check"
      CHECK (("cancelledAt" IS NULL) = ("cancelledById" IS NULL))
);

-- Destino de la FK compuesta de appointments y lados hijos de las FK a users.
CREATE UNIQUE INDEX "appointment_series_tenant_id_key" ON "appointment_series"("tenantId", "id");
CREATE INDEX "appointment_series_created_by_idx" ON "appointment_series"("createdById");
CREATE INDEX "appointment_series_cancelled_by_idx" ON "appointment_series"("cancelledById");

ALTER TABLE "appointment_series" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "appointment_series"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "appointment_series" FORCE ROW LEVEL SECURITY;

-- La serie no se borra: sus citas la referencian (RESTRICT) y se cancelan.
REVOKE DELETE, TRUNCATE ON "appointment_series" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- appointments: la serie y la posición en ella
-- ---------------------------------------------------------------------------

ALTER TABLE "appointments"
  ADD COLUMN "seriesId" UUID,
  ADD COLUMN "seriesIndex" SMALLINT;

ALTER TABLE "appointments" ADD CONSTRAINT "appointments_series_check" CHECK (
    ("seriesId" IS NULL) = ("seriesIndex" IS NULL)
    AND ("seriesIndex" IS NULL OR "seriesIndex" BETWEEN 1 AND 26)
  ) NOT VALID;

ALTER TABLE "appointments" ADD CONSTRAINT "appointments_series_fkey"
  FOREIGN KEY ("tenantId", "seriesId")
  REFERENCES "appointment_series"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
