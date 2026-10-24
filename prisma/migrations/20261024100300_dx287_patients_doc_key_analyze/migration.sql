-- DX-287: estadísticas de patients."docKey" recién rellenada. Sin ellas el
-- planificador estima `"docKey" = ANY(250 claves)` con la selectividad por
-- defecto y puede preferir recorrer la clínica a usar el índice hasta que
-- pase el autovacuum. ANALYZE de una columna toma SHARE UPDATE EXCLUSIVE:
-- no bloquea lecturas ni escrituras.
SET LOCAL lock_timeout = '5s';

ANALYZE "patients" ("docKey");
