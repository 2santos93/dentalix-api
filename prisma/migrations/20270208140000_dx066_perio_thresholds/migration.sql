-- DX-066: umbrales de sondaje del periodontograma por clínica.
--
-- Cambios (ADITIVOS, compatibles hacia atrás: la API anterior no lee ni
-- escribe estas columnas):
--   tenants."perioPdAlertMm"   sondaje (mm) desde el que un sitio está en
--                       alerta (4 de fábrica).
--   tenants."perioPdSevereMm"  sondaje (mm) desde el que es severo (6 de
--                       fábrica).
-- Colorean la carta y cuentan en los índices (sitesAlertOrMore /
-- sitesSevereOrMore). Los cambia solo el ADMIN (PUT /perio/settings,
-- auditado). DEFAULT constante: solo metadatos, sin reescribir la tabla.
-- CHECK NOT VALID (alerta 2..10, severo 3..12, alerta < severo); se valida en
-- 20270208140100, en su propia transacción.
--
-- La furca MP/DP de los molares superiores no necesita columna: se guarda en
-- los sitios ML (MP) y DL (DP) que ya existen en perio_site_measures; la API
-- valida en qué dientes y sitios se puede registrar. CALC ya va en el bitmask
-- "flags" (8). Ninguna tabla nueva ni columna hacia patients: la fusión de
-- pacientes (DX-266) no cambia.
--
-- Vuelta atrás: desplegar la API anterior y
--   ALTER TABLE public."tenants" DROP CONSTRAINT "tenants_perio_pd_thresholds_check",
--     DROP COLUMN "perioPdAlertMm", DROP COLUMN "perioPdSevereMm";

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants"
  ADD COLUMN "perioPdAlertMm" SMALLINT NOT NULL DEFAULT 4,
  ADD COLUMN "perioPdSevereMm" SMALLINT NOT NULL DEFAULT 6;

ALTER TABLE "tenants" ADD CONSTRAINT "tenants_perio_pd_thresholds_check"
  CHECK (
    "perioPdAlertMm" BETWEEN 2 AND 10
    AND "perioPdSevereMm" BETWEEN 3 AND 12
    AND "perioPdAlertMm" < "perioPdSevereMm"
  ) NOT VALID;
