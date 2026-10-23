-- SEC-047: el informe de descuentos (DX-204) muestra la rebaja de convenio de
-- cada ítem resuelto por convenio con quién asignó el convenio y quién creó el
-- ítem. Quién asignó ya está en patient_agreements."createdById"; quién creó
-- el ítem no se guardaba en ningún sitio.
--
-- Cambios:
--   treatment_plan_items   columna NULL "createdById": usuario que dio de alta
--                          el ítem. Puntero suave a User, como
--                          treatment_plans."createdById" (sin FK ni índice: solo
--                          se lee dentro del periodo del informe). Una
--                          alternativa (DX-040) lo copia de su ítem de origen,
--                          como el resto de la foto del precio.
--                          NULL en los ítems anteriores: «Sin registrar» (sin
--                          backfill: no se inventa quién los creó).
--
-- Compatible hacia atrás: solo AÑADE una columna NULL sin DEFAULT (no reescribe
-- la tabla). Ni CHECK, ni FK, ni cambios en RLS o en los triggers de bloqueo
-- (la columna solo se escribe en el alta). Grants: no aplica (tabla existente).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plan_items" ADD COLUMN "createdById" UUID;
