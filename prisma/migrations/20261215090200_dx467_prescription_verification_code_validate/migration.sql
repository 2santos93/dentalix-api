-- DX-467: cierra el relleno del código de verificación
-- (20261215090100_dx467_prescription_verification_code_backfill).
--
-- VALIDATE (SHARE UPDATE EXCLUSIVE: no bloquea lecturas ni escrituras) y un
-- CHECK ve todas las filas aunque el owner esté sujeto a la RLS (DX-134): si
-- queda alguna receta sin código o con otra forma, falla de forma ruidosa.
-- Con el CHECK validado, SET NOT NULL no recorre la tabla.
--
-- Índice ÚNICO global (no por clínica): un código nombra UNA receta en todo
-- Dentalix, y la búsqueda pública por código lo usa. Sin CONCURRENTLY: `prisma
-- migrate deploy` ejecuta cada migración en una transacción; `prescriptions`
-- es pequeña y el SHARE dura lo que el CREATE INDEX (molde de
-- 20261212090200_dx015bis_recall_type_not_null). El CHECK se queda: además del
-- NOT NULL fija la forma del código.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "prescriptions" VALIDATE CONSTRAINT "prescriptions_verification_code_check";
ALTER TABLE "prescriptions" ALTER COLUMN "verificationCode" SET NOT NULL;

CREATE UNIQUE INDEX "prescriptions_verification_code_key"
  ON "prescriptions"("verificationCode");
