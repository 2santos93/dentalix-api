-- DX-379: VALIDATE sola (SHARE UPDATE EXCLUSIVE): no bloquea lecturas ni
-- escrituras de `treatment_plans`, y se separa del ADD COLUMN
-- (20261204090000_dx379_quote_validity) como DX-019-bis. Todas las filas
-- existentes tienen las dos columnas a NULL, que cumplen los dos CHECK.
ALTER TABLE "treatment_plans" VALIDATE CONSTRAINT "treatment_plans_quote_validity_pair_check";
ALTER TABLE "treatment_plans" VALIDATE CONSTRAINT "treatment_plans_quote_validity_order_check";
