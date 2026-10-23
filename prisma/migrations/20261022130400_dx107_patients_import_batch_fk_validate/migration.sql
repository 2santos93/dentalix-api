-- DX-107: valida patients_import_batch_fkey (añadida NOT VALID en
-- 20261022130100) sin recorrer patients (revisión 2026-10-23, I3).
--
-- La columna "import_batch_id" nació entera a NULL y la FK NOT VALID ya se
-- aplica a toda fila nueva o modificada desde entonces: no puede haber
-- huérfanas. Validar solo la deja marcada como válida en el catálogo.
--
-- Por qué no bloquea patients más que un instante:
--   1. ANALYZE de la columna ANTES del NO FORCE: toma SHARE UPDATE EXCLUSIVE
--      (no bloquea lecturas ni escrituras) y deja la estadística «casi todo
--      NULL»; sin ella el planificador supone 99,5 % no NULL.
--   2. Con esa estadística, la comprobación de VALIDATE (filas con
--      import_batch_id NOT NULL sin lote) usa el índice parcial
--      patients_tenant_import_batch_idx (20261022130300), que solo tiene los
--      importados: no lee la tabla.
--   3. DX-134: NO FORCE en la hija (patients) y en la referenciada
--      (patient_import_batches) mientras se valida, y FORCE al final, en la
--      misma transacción. NO FORCE toma ACCESS EXCLUSIVE hasta el COMMIT, que
--      llega en cuanto termina el VALIDATE del paso 2.
--
-- lock_timeout acota la espera por el bloqueo (si patients está ocupada, la
-- migración falla en 5 s sin dejar nada a medias y se repite).
-- Compatible hacia atrás: no cambia el esquema. Grants: no aplica.

SET LOCAL lock_timeout = '5s';

ANALYZE "patients" ("import_batch_id");

ALTER TABLE "patients" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_import_batches" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_import_batch_fkey";
ALTER TABLE "patient_import_batches" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;
