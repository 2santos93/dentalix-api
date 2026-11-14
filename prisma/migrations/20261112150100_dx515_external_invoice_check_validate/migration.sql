-- DX-515: valida payments_external_invoice_number_check (20261112150000).
-- VALIDATE de un CHECK toma SHARE UPDATE EXCLUSIVE: recorre payments sin
-- bloquear lecturas ni escrituras (sola, sin otro ALTER que suba el bloqueo).
-- La columna nació NULL en todas las filas, así que cumplen. Un CHECK ve todas
-- las filas (no usa la RLS).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_external_invoice_number_check";
