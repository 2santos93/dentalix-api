-- DX-393: consulta de diagnóstico (solo lectura) de los gastos que las guardas
-- de 20261105120000_dx393_expense_integrity ya no dejan escribir, pero que se
-- pudieron escribir antes. No borra ni cambia nada: corregirlos es decisión de
-- la clínica (anular los pagos vivos que sobran se puede siempre).
--
-- Ejecutar con un rol con BYPASSRLS (el owner de DIRECT_URL), para ver todas
-- las clínicas:
--   psql "$DIRECT_URL_SIN_SCHEMA" -X -v ON_ERROR_STOP=1 -f prisma/scripts/expense-integrity-report.sql
-- Una sola sentencia: también sirve para un cliente que no admita varias.
--
-- Columnas: problema, clínica, sede, gasto, pago o ajuste (si aplica) e
-- importes. Sin proveedor ni descripción del gasto.
--   VOIDED_WITH_LIVE_PAYMENTS  gasto anulado con pagos vivos (live_paid > 0).
--   PAID_OVER_AMOUNT           Σ pagos vivos > importe del gasto.
--   OUTFLOW_VOID_MISMATCH      ajuste OUTFLOW_VOID con otro importe, otra
--                              moneda u otra caja de origen que su salida, o
--                              sobre una salida aún viva.
WITH live AS (
  SELECT p."tenantId", p."expenseId", SUM(p."amount") AS "livePaid"
    FROM "expense_payments" p
   WHERE p."voidedAt" IS NULL
   GROUP BY p."tenantId", p."expenseId"
)
SELECT 'VOIDED_WITH_LIVE_PAYMENTS' AS "problem", e."tenantId", e."locationId",
       e."id" AS "expenseId", NULL::uuid AS "rowId",
       e."amount" AS "expected", l."livePaid" AS "actual"
  FROM "expenses" e
  JOIN live l ON l."tenantId" = e."tenantId" AND l."expenseId" = e."id"
 WHERE e."voidedAt" IS NOT NULL
UNION ALL
SELECT 'PAID_OVER_AMOUNT', e."tenantId", e."locationId", e."id", NULL::uuid,
       e."amount", l."livePaid"
  FROM "expenses" e
  JOIN live l ON l."tenantId" = e."tenantId" AND l."expenseId" = e."id"
 WHERE l."livePaid" > e."amount"
UNION ALL
SELECT 'OUTFLOW_VOID_MISMATCH', a."tenantId", a."locationId", p."expenseId",
       a."id", p."amount", a."amount"
  FROM "cash_session_adjustments" a
  JOIN "expense_payments" p
    ON p."tenantId" = a."tenantId" AND p."id" = a."expensePaymentId"
 WHERE a."kind" = 'OUTFLOW_VOID'
   AND (p."amount" <> a."amount" OR p."currency" <> a."currency"
        OR p."cashSessionId" IS DISTINCT FROM a."originalSessionId"
        OR p."voidedAt" IS NULL)
ORDER BY 1, 2, 3, 4;
