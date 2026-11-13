-- DX-410 «Rentabilidad por sede», base «Caja»: los pagos de gastos VIVOS de
-- unas sedes en un rango de `paidOn` (día civil). Hasta ahora la tabla solo
-- tenía índices por gasto y por caja, y la consulta leía TODOS los pagos de
-- la clínica para quedarse con los del período (EXPLAIN con 3.500 pagos por
-- clínica: 2.546 bloques leídos para 149 filas). Con este índice lee solo los
-- del rango de cada sede.
--
-- Parcial (WHERE "voidedAt" IS NULL), como los de `payments`: el WHERE vive
-- solo aquí; schema.prisma lo declara con el mismo `map` y columnas para que
-- migrate status/deploy no vean drift. NO aceptes un diff de `migrate dev` que
-- lo vuelva completo.
--
-- No CONCURRENTLY (como 20261105120100_dx393_expenses_list_idx): va en la
-- transacción de Prisma con `lock_timeout`, que solo acota la ESPERA por el
-- bloqueo. Mientras se construye, el SHARE de `CREATE INDEX` frena las
-- escrituras de pagos de gastos (no las lecturas): con decenas de miles de
-- pagos son decenas de ms. Si falla por `lock_timeout`, no deja nada a medias:
-- `npx prisma migrate resolve --rolled-back 20261218100000_dx410_expense_payments_paid_on_idx`
-- y repetir. Aditivo: la réplica anterior no depende de él.

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "expense_payments_tenant_location_paid_on_idx"
  ON "expense_payments"("tenantId", "locationId", "paidOn")
  WHERE "voidedAt" IS NULL;
