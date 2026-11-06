-- DX-540: valida el CHECK que la migración anterior dejó NOT VALID.
-- VALIDATE CONSTRAINT toma SHARE UPDATE EXCLUSIVE: recorre la tabla sin
-- bloquear lecturas ni escrituras (por eso va en su propia migración). Todas
-- las filas anteriores tienen la columna a NULL, que el CHECK admite.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "clinical_entries" VALIDATE CONSTRAINT "clinical_entries_author_professional_license_check";
