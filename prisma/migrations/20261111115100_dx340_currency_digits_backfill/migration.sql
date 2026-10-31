-- DX-340: rellena "minor_units" y "rounding_digits" desde la referencia
-- versionada prisma/reference/currency-digits.ts (generada por
-- prisma/scripts/generate-currency-digits.ts desde la List One de SIX del
-- 2026-09-17) y valida las CHECK de 20261111100000. Solo se escriben las
-- monedas con 0: el resto ya tiene el 2 por defecto.
--
-- rounding_digits CONGELA la regla anterior a DX-340 (la lista fija
-- ZERO_DECIMAL_CURRENCIES de la API y la web): 0 para las monedas sin
-- decimales en CLDR 47 y para el conjunto anterior a G1 (COP, CLP, JPY, KRW,
-- PYG). Así ningún descuento ni precio nuevo cambia. Difieren de ISO (minor
-- units 2, redondeo 0): AFN, ALL, COP, IRR, KPW, LAK, LBP, MGA, MMK, RSD, SOS,
-- SYP, YER (decisión pendiente del dueño, README «Redondeo de importes»).
--
-- Idempotente (UPDATE a un valor fijo). Toca solo ~30 filas de una tabla de
-- referencia; ningún importe ni documento.
-- Rollback: UPDATE "currencies" SET "minor_units" = 2, "rounding_digits" = 2;

SET LOCAL lock_timeout = '5s';

-- Primero el redondeo: la CHECK NOT VALID ya vigila las filas que se
-- actualizan (rounding_digits <= minor_units).
UPDATE "currencies" SET "rounding_digits" = 0 WHERE "code" IN ('AFN', 'ALL', 'BIF', 'CLP', 'COP', 'DJF', 'GNF', 'IRR', 'ISK', 'JPY', 'KMF', 'KPW', 'KRW', 'LAK', 'LBP', 'MGA', 'MMK', 'PYG', 'RSD', 'RWF', 'SOS', 'SYP', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF', 'YER');
UPDATE "currencies" SET "minor_units" = 0 WHERE "code" IN ('BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF');

ALTER TABLE "currencies" VALIDATE CONSTRAINT "currencies_minor_units_check";
ALTER TABLE "currencies" VALIDATE CONSTRAINT "currencies_rounding_digits_check";
