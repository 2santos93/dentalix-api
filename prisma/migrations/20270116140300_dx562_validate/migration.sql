-- DX-562: valida appointments_series_fkey y appointments_series_check
-- (añadidas NOT VALID en 20270116140100) sin recorrer appointments. Mismo
-- procedimiento que 20261227090200_dx263_appointments_import_batch_fk_validate:
--
--   1. ANALYZE de la columna antes del NO FORCE (SHARE UPDATE EXCLUSIVE, no
--      bloquea): estadística «todo NULL», así la comprobación de la FK (filas
--      con "seriesId" NOT NULL sin serie) usa el índice parcial
--      appointments_tenant_series_index_key (20270116140200).
--   2. DX-134: NO FORCE en la hija (appointments) y en la referenciada
--      (appointment_series) mientras se valida, y FORCE al final, en la misma
--      transacción.
--
-- Las columnas nacieron enteras a NULL y las restricciones NOT VALID ya se
-- aplican a toda fila nueva o modificada: no puede haber filas que las
-- incumplan. lock_timeout acota la espera (si appointments está ocupada,
-- falla en 5 s sin dejar nada a medias y se repite). Compatible hacia atrás:
-- no cambia el esquema.

SET LOCAL lock_timeout = '5s';

ANALYZE "appointments" ("seriesId");

ALTER TABLE "appointments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointment_series" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" VALIDATE CONSTRAINT "appointments_series_fkey";
ALTER TABLE "appointments" VALIDATE CONSTRAINT "appointments_series_check";
ALTER TABLE "appointment_series" FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
