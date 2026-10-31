-- DX-470: valida las CHECK que 20261110100000 añadió NOT VALID (DB-029). Las
-- columnas son nuevas y llevan sus valores por defecto: ninguna fila falla.
-- VALIDATE solo toma SHARE UPDATE EXCLUSIVE (no bloquea lecturas ni escrituras).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "appointments" VALIDATE CONSTRAINT "appointments_triage_check";
ALTER TABLE "appointments" VALIDATE CONSTRAINT "appointments_overbooked_walk_in_check";
ALTER TABLE "appointment_reserved_overrides" VALIDATE CONSTRAINT "appointment_reserved_overrides_blocks_check";
