-- DX-427: valida los CHECK que 20261107120000 añadió NOT VALID. VALIDATE de
-- un CHECK toma SHARE UPDATE EXCLUSIVE: recorre cada tabla sin bloquear los
-- registros nuevos de anestesia ni de sedación. Lo que escribió la app ya
-- cumple (sus reglas son las mismas o más estrictas); para comprobarlo antes
-- de desplegar, la consulta previa del README («DX-427»).
--
-- lock_timeout 5 s; para reintentar, `prisma migrate resolve --rolled-back
-- 20261107120100_dx427_anesthesia_sedation_validate` y `deploy`.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "anesthesia_administrations" VALIDATE CONSTRAINT "anesthesia_administrations_dose_range";
ALTER TABLE "anesthesia_administrations" VALIDATE CONSTRAINT "anesthesia_administrations_dose_derived";
ALTER TABLE "anesthesia_administrations" VALIDATE CONSTRAINT "anesthesia_administrations_cumulative";
ALTER TABLE "anesthesia_administrations" VALIDATE CONSTRAINT "anesthesia_administrations_not_future";
ALTER TABLE "sedation_records" VALIDATE CONSTRAINT "sedation_records_not_future";
ALTER TABLE "sedation_checklists" VALIDATE CONSTRAINT "sedation_checklists_not_future";
ALTER TABLE "sedation_agent_administrations" VALIDATE CONSTRAINT "sedation_agent_administrations_not_future";
ALTER TABLE "sedation_vitals" VALIDATE CONSTRAINT "sedation_vitals_not_future";
ALTER TABLE "sedation_discharges" VALIDATE CONSTRAINT "sedation_discharges_not_future";
