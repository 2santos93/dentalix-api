-- DX-326 (epic DX-311 «Producto global, sin supuestos de país»), fase 1:
-- fuera el CHECK de tipo y país de `payers`. Cualquier tipo admite cualquier
-- país o ninguno; la columna "country" queda sin uso hasta DX-312, que la
-- borra.
--
-- Sin IF EXISTS: si el CHECK falta, la BD no está en el estado esperado y la
-- migración debe fallar.
--
-- DROP CONSTRAINT toma un ACCESS EXCLUSIVE breve sobre `payers` y no lee la
-- tabla. Ninguna fila cambia, así que no hay bracket NO FORCE/FORCE: la RLS
-- FORCE de `payers` no se toca.
--
-- lock_timeout 5 s: si una transacción larga retiene la tabla, falla limpia y
-- se reintenta el deploy, sin dejar en cola a los lectores.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payers" DROP CONSTRAINT "payers_type_country_check";
