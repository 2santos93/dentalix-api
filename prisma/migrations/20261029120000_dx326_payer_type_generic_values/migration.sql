-- DX-326 (epic DX-311 «Producto global, sin supuestos de país»), fase 1:
-- tipos de pagador genéricos. Solo el enum.
--
-- Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326.
-- Correspondencia fija (src/modules/payers/domain/legacy-payer-type.ts):
--   MUTUA_ES     → INSURER
--   PREPAGADA_CO → PREPAID_PLAN
--   EPS_CO       → PUBLIC_SYSTEM
--   EMPRESA      → EMPLOYER
--   OTRO         → OTHER
--
-- Sin relleno: en fase 1 ninguna fila usa todavía los valores nuevos. La API
-- sigue guardando el código anterior para que las réplicas anteriores lean
-- cada fila; los valores se añaden ya para que el cliente de fase 1 sepa
-- leerlos cuando la fase 2 rellene.
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea. No reescribe filas.
--
-- lock_timeout 5 s: si una transacción larga retiene el tipo, falla limpia;
-- para reintentar, `npx prisma migrate resolve --rolled-back
-- 20261029120000_dx326_payer_type_generic_values` y de nuevo el deploy.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "PayerType" ADD VALUE IF NOT EXISTS 'INSURER';
ALTER TYPE "PayerType" ADD VALUE IF NOT EXISTS 'PREPAID_PLAN';
ALTER TYPE "PayerType" ADD VALUE IF NOT EXISTS 'PUBLIC_SYSTEM';
ALTER TYPE "PayerType" ADD VALUE IF NOT EXISTS 'EMPLOYER';
ALTER TYPE "PayerType" ADD VALUE IF NOT EXISTS 'OTHER';
