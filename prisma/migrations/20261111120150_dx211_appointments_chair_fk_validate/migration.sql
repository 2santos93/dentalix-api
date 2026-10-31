-- DX-211 (revisión M1): valida la FK appointments_chair_fkey que
-- 20261111120100_dx211_chairs añadió NOT VALID.
--
-- VALIDATE CONSTRAINT solo toma SHARE UPDATE EXCLUSIVE sobre `appointments`
-- (no bloquea lecturas ni escrituras) y recorre la tabla una vez; todas las
-- filas previas tienen "chairId" NULL, así que no hay nada que pueda fallar.
--
-- FK bajo FORCE (DX-134): validar una FK lee la hija y la referenciada con la
-- RLS del owner, así que se quita FORCE a las dos en esta misma transacción y
-- se devuelve al final.
--
-- Vuelta atrás: no hace falta (la FK sigue existiendo NOT VALID si se omite).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "appointments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "chairs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" VALIDATE CONSTRAINT "appointments_chair_fkey";
ALTER TABLE "chairs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
