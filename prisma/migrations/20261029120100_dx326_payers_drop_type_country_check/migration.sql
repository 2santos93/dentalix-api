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
-- lock_timeout 5 s: mientras el ALTER espera su ACCESS EXCLUSIVE, los lectores
-- nuevos de `payers` hacen cola tras él; el timeout limita esa cola a 5 s como
-- mucho. Si una transacción larga retiene la tabla, falla limpia tras esa
-- espera; para reintentar, `npx prisma migrate resolve --rolled-back
-- 20261029120100_dx326_payers_drop_type_country_check` y de nuevo el deploy.
--
-- Caso «ya aplicada»: si la transacción hizo COMMIT pero Prisma perdió la
-- conexión antes de anotar `finished_at`, `_prisma_migrations` la marca
-- fallida aunque el CHECK ya no exista, y el reintento anterior fallaría
-- siempre (`constraint "payers_type_country_check" … does not exist`). Antes
-- de reintentar, comprobar `SELECT 1 FROM pg_constraint WHERE conname =
-- 'payers_type_country_check'`; si no devuelve fila, `npx prisma migrate
-- resolve --applied 20261029120100_dx326_payers_drop_type_country_check` en
-- lugar de `--rolled-back`.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payers" DROP CONSTRAINT "payers_type_country_check";
