-- DX-330: la fecha de fin de conservación que una historia ya tenía cuando la
-- clínica redujo su plazo (R6). La escribe solo el cambio de plazo y nunca
-- baja: una reducción no acorta la retención de una historia ya protegida.
--
-- Expand, solo `patients`: una columna DATE nullable y sin default. Solo
-- catálogo, así que no reescribe `patients`. Sin índice (la condición del
-- suelo es residual sobre `patients_tenant_last_attention_live_idx`) y sin
-- CHECK. Sin relleno: NULL = la historia no tiene suelo.
--
-- lock_timeout 5 s, como la migración anterior: `patients` es la tabla más
-- leída; si el ALTER no consigue su bloqueo, se reintenta el deploy.
--
-- Grants: no aplica (columna nueva de tabla ya concedida). RLS: `patients`
-- mantiene FORCE; esta migración no la toca.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients" ADD COLUMN "retention_floor_until" DATE;
