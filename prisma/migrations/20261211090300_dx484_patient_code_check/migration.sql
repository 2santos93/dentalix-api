-- DX-484: CHECK del código, NOT VALID (solo catálogo, un instante de ACCESS
-- EXCLUSIVE). Desde aquí todo INSERT y UPDATE de patients lo cumple; las filas
-- existentes las comprueba 20261211090400 sin bloquear las escrituras.
--
-- Va después del relleno, no con la columna: un CHECK NOT VALID ya se aplica a
-- cada UPDATE, y editar un paciente todavía con código 0 habría fallado.
--
-- "patientCode" IS NOT NULL dentro del CHECK: una vez validado, le demuestra a
-- SET NOT NULL que no hay nulos, y este se salta el recorrido de la tabla bajo
-- ACCESS EXCLUSIVE (un CHECK de solo `> 0` deja pasar NULL y no lo demuestra).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients"
  ADD CONSTRAINT "patients_patient_code_check"
  CHECK ("patientCode" IS NOT NULL AND "patientCode" > 0) NOT VALID;
