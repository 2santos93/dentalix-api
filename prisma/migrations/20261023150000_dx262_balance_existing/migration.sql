-- DX-262 (QA D1): subir dos veces la misma hoja de saldos no duplica la deuda.
--
-- Cambios en patient_import_batches:
--   "balanceAddToExisting"  la administradora marcó «Añadir aunque ya tenga
--                       saldo migrado» al subir la hoja: se crea aunque el
--                       paciente ya tenga uno vivo en esa moneda de otro lote.
--                       Sin marcar (por defecto), el dry-run da error en esas
--                       filas y el trabajo vuelve a comprobarlo al importar
--                       (dos lotes validados a la vez con la misma hoja).
--   "balanceExistingCount"  saldos no creados por eso al importar.
--
-- Sin bloqueo largo: ADD COLUMN con DEFAULT constante es solo de catálogo
-- (PG ≥ 11) y la tabla es pequeña (un lote por importación).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "patient_import_batches"
  ADD COLUMN "balanceAddToExisting" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "balanceExistingCount" INTEGER NOT NULL DEFAULT 0;
