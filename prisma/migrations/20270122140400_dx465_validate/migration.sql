-- DX-465: VALIDATE de los CHECK añadidos NOT VALID en 20270122140000, en su
-- propia transacción (SHARE UPDATE EXCLUSIVE: no bloquea las escrituras).
-- Columnas nuevas (en 0 o NULL hasta el relleno, que las deja dentro de la
-- regla): no hay nada que corregir. Solo CHECK, sin FK: la validación de un
-- CHECK ve todas las filas aunque la tabla tenga RLS FORCE (DX-134), así que
-- no hace falta NO FORCE.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "patient_recalls" VALIDATE CONSTRAINT "patient_recalls_attempt_count_check";
ALTER TABLE "recall_contacts" VALIDATE CONSTRAINT "recall_contacts_callback_check";
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_phone_review_check";
