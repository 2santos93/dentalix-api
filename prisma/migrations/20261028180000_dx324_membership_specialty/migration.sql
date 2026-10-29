-- DX-324 (epic DX-311 «Producto global, sin supuestos de país»): especialidad
-- del profesional en esta clínica, opcional. La receta la congela en su foto
-- al emitir (prescriptions."professionalSpecialty") y la imprime si existe.
--
-- Expand, solo `clinic_memberships`: columna NULLABLE sin DEFAULT (solo
-- catálogo, sin reescribir la tabla). Las réplicas anteriores no la leen ni
-- la escriben.
--
-- CHECK 1..80 caracteres sin los espacios de los extremos (la API responde
-- 400 antes; esto es la red). NOT VALID + VALIDATE en la misma transacción:
-- el VALIDATE recorre la tabla bajo el ACCESS EXCLUSIVE que ya tomó el ADD
-- COLUMN (no bajo un bloqueo más débil). Es breve porque la columna es nueva
-- y todas las filas tienen NULL. En una tabla grande, el VALIDATE iría en
-- una migración posterior.
--
-- lock_timeout 5 s: si una transacción larga retiene la tabla, falla limpia
-- y se reintenta el deploy, sin dejar en cola a los lectores.
--
-- Sin trigger UTC (DX-226): no hay columnas de fecha. Grants: no aplica
-- (columna nueva de tabla existente).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "clinic_memberships"
  ADD COLUMN "professionalSpecialty" TEXT;

ALTER TABLE "clinic_memberships"
  ADD CONSTRAINT "clinic_memberships_professional_specialty_check" CHECK (
    "professionalSpecialty" IS NULL
    OR length(btrim("professionalSpecialty")) BETWEEN 1 AND 80
  ) NOT VALID;
ALTER TABLE "clinic_memberships"
  VALIDATE CONSTRAINT "clinic_memberships_professional_specialty_check";
