-- DX-467: el código de verificación pasa a obligatorio (4 de 5).
--
-- Tras el barrido (20261127090200) ninguna receta queda sin código:
--   1. VALIDATE de los dos CHECK de 20261127090000 (SHARE UPDATE EXCLUSIVE:
--      recorre la tabla sin bloquear las escrituras).
--   2. SET NOT NULL: con prescriptions_verification_code_present_check ya
--      validado, Postgres (≥ 12) no vuelve a recorrer la tabla; ACCESS
--      EXCLUSIVE de milisegundos.
--   3. DROP de prescriptions_verification_code_present_check: el NOT NULL
--      dice lo mismo.
-- Si el VALIDATE falla es que alguna receta quedó sin código (el barrido se
-- cortó): repetir el barrido y luego esta migración.
--
-- Compatible hacia atrás: una réplica anterior que inserte sin nombrar la
-- columna recibe el DEFAULT (prescription_verification_code()).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "prescriptions" VALIDATE CONSTRAINT "prescriptions_verification_code_format_check";
ALTER TABLE "prescriptions" VALIDATE CONSTRAINT "prescriptions_verification_code_present_check";
ALTER TABLE "prescriptions" ALTER COLUMN "verificationCode" SET NOT NULL;
ALTER TABLE "prescriptions" DROP CONSTRAINT "prescriptions_verification_code_present_check";
