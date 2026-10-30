-- DX-393 (auditoría DB-059): índices con el orden EXACTO de la lista de gastos
-- (`invoiceDate` DESC, `createdAt` DESC, `id` DESC), para que la página salga
-- del índice en vez de ordenar todos los gastos de la clínica:
--   expenses_tenant_invoice_created_idx           vista por defecto (todas
--                                                 las sedes visibles).
--   expenses_tenant_location_invoice_created_idx  filtro o cabecera de sede.
-- El índice anterior `expenses_tenant_location_invoice_idx` (sin
-- `createdAt`) se queda: es aditivo y las réplicas anteriores no dependen de
-- ninguno de los dos.
--
-- No CONCURRENTLY: va en la transacción de Prisma con `lock_timeout`, que solo
-- acota la ESPERA por el bloqueo. Mientras se construye, el SHARE de
-- `CREATE INDEX` frena las escrituras de gastos (no las lecturas): con 20.000
-- gastos son decenas de ms (README, «Integridad entre gasto y pagos
-- (DX-393)»). Si falla por `lock_timeout`, no deja nada a medias:
-- `npx prisma migrate resolve --rolled-back 20261105120100_dx393_expenses_list_idx`
-- y repetir.

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "expenses_tenant_invoice_created_idx"
  ON "expenses"("tenantId", "invoiceDate" DESC, "createdAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "expenses_tenant_location_invoice_created_idx"
  ON "expenses"("tenantId", "locationId", "invoiceDate" DESC, "createdAt" DESC, "id" DESC);
