-- DX-413 (OPS-050): una tasa registrada mientras el barrido recorre la clínica
-- no debe quedar pisada por el aplazamiento del intento que ya estaba en
-- curso. `wake()` (la clínica registró o corrigió una tasa) pasa a contar sus
-- despertares en la propia fila:
--   "wakeCount"   despertares desde que existe la fila (0 por defecto). El
--                 barrido lo lee con el abono y solo aplaza si sigue igual.
--
-- Compatible hacia atrás: una columna nueva con default constante. Una réplica
-- anterior no la nombra: lee y aplaza como antes (sin la protección, no
-- peor que hoy). RLS FORCE y el GRANT de la tabla no cambian (ADD COLUMN
-- hereda ambos).
--
-- Bloqueos: ADD COLUMN con default constante es solo de catálogo (sin
-- reescribir la tabla), pero toma ACCESS EXCLUSIVE un instante.
-- lock_timeout 5 s: si un barrido la retiene falla limpia; se ejecuta `npx
-- prisma migrate resolve --rolled-back
-- 20261117110000_dx413_payment_base_retries_wake_count` y se repite
-- `migrate deploy`.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "payment_base_retries"
  ADD COLUMN "wakeCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "payment_base_retries"
  ADD CONSTRAINT "payment_base_retries_wake_count_check" CHECK ("wakeCount" >= 0);
