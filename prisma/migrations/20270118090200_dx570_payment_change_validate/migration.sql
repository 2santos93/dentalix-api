-- DX-570: valida los CHECK añadidos NOT VALID en 20270118090100 (en su propio
-- fichero: VALIDATE toma SHARE UPDATE EXCLUSIVE, no frena las escrituras, y
-- no debe ir en la transacción del ADD, que retiene ACCESS EXCLUSIVE).
-- Las filas existentes tienen las columnas nuevas a NULL: pasan siempre.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_tendered_check";
ALTER TABLE "cash_session_adjustments" VALIDATE CONSTRAINT "cash_session_adjustments_kind_check";
