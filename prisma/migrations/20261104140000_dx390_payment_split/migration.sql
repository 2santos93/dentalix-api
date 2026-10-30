-- DX-390 (porción 3 de DX-377): cobro dividido en varias formas de pago con
-- un solo recibo.
--
-- Cambios en payments:
--   "splitId"    id de la línea 1 del cobro (la que lleva el recibo y la
--                Idempotency-Key), también en la propia línea 1. FK COMPUESTA
--                ("tenantId", "splitId") → payments("tenantId", "id"): las
--                líneas son de la MISMA clínica.
--   "splitLine"  número de la línea (1–5).
--   CHECK payments_split_check: las dos juntas o ninguna, la línea entre 1 y
--   5, y la línea 1 es exactamente la de "splitId".
--
-- Compatible hacia atrás: solo AÑADE columnas NULL sin DEFAULT, un CHECK y una
-- FK NOT VALID. Una réplica anterior no nombra las columnas: sus abonos nacen
-- de una sola forma de pago, como hasta ahora. El índice de las líneas va en
-- 20261104140100 (CONCURRENTLY) y el CHECK se valida en 20261104140200; la FK
-- se queda NOT VALID (ver allí).
--
-- ADD COLUMN y ADD CONSTRAINT NOT VALID toman un ACCESS EXCLUSIVE breve sobre
-- payments, sin leerla. lock_timeout 5 s: si una transacción larga lo retiene,
-- falla limpia (`prisma migrate resolve --rolled-back
-- 20261104140000_dx390_payment_split` y de nuevo el deploy).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payments"
  ADD COLUMN "splitId" UUID,
  ADD COLUMN "splitLine" SMALLINT;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_split_check" CHECK (
    ("splitId" IS NULL AND "splitLine" IS NULL)
    OR (
      "splitId" IS NOT NULL
      AND "splitLine" IS NOT NULL
      AND "splitLine" BETWEEN 1 AND 5
      AND ("splitLine" = 1) = ("splitId" = "id")
    )
  ) NOT VALID;

-- MATCH SIMPLE: con "splitId" NULL la FK no se evalúa. Destino: el único
-- payments_tenant_id_key (DX-380). La línea 1 se apunta a sí misma: la FK se
-- comprueba al final de la sentencia, con la fila ya insertada.
ALTER TABLE "payments" ADD CONSTRAINT "payments_split_fkey"
  FOREIGN KEY ("tenantId", "splitId") REFERENCES "payments"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
