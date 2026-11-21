-- DX-585: la tasa oficial del BCV, una fila por «Fecha Valor».
--
--   "valueDate"  la fecha valor que publica el BCV con la tasa (normalmente el
--                siguiente día hábil). PK: una tasa por fecha valor. La tasa
--                del día D de una sede es la de la fecha valor <= D más
--                reciente (fines de semana y feriados usan la del último día
--                hábil); la elige la API.
--   "usdVes"     bolívares por 1 USD, como los publica el BCV (8 decimales).
--   "eurVes"     bolívares por 1 EUR. EUR por USD = usdVes / eurVes (la API).
--   "fetchedAt"  cuándo se consultó (y se guardó) la tasa.
--   "origin"     BCV (la página oficial) o FALLBACK (el respaldo, si la
--                oficial no contestó o no se pudo leer).
--
-- SIN RLS y sin "tenantId" (a propósito), como exchange_rate_snapshots: es un
-- dato de referencia GLOBAL, el mismo para todas las clínicas. La escribe el
-- trabajo programado exchange.bcv-refresh (sin clínica) y la leen las
-- conversiones de las clínicas con fuente BCV. Sin columnas hacia patients:
-- dx_merge_patients (DX-266) no cambia.
--
-- Grants: dentalix_app lee, inserta y actualiza (la corrección de una fecha
-- valor ya guardada); no borra ni vacía: una tasa que congeló algún abono es
-- historia.
--
-- Tabla nueva y vacía: los CHECK van en el CREATE (no hay filas que validar)
-- y no bloquea ninguna tabla existente.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "bcv_rate_snapshots" (
    "valueDate" DATE NOT NULL,
    "usdVes" DECIMAL(18,8) NOT NULL,
    "eurVes" DECIMAL(18,8) NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "origin" TEXT NOT NULL,

    CONSTRAINT "bcv_rate_snapshots_pkey" PRIMARY KEY ("valueDate"),
    CONSTRAINT "bcv_rate_snapshots_rates_check" CHECK ("usdVes" > 0 AND "eurVes" > 0),
    CONSTRAINT "bcv_rate_snapshots_origin_check" CHECK ("origin" IN ('BCV', 'FALLBACK'))
);

-- ALTER DEFAULT PRIVILEGES da a dentalix_app SELECT/INSERT/UPDATE/DELETE en
-- las tablas nuevas: aquí se le quita lo que no necesita.
REVOKE ALL ON "bcv_rate_snapshots" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    REVOKE ALL ON "bcv_rate_snapshots" FROM dentalix_app;
    GRANT SELECT, INSERT, UPDATE ON "bcv_rate_snapshots" TO dentalix_app;
  END IF;
END;
$$;
